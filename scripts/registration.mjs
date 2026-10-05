import { constants } from 'node:fs';
import { lstat, mkdir, open, link, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const HOST_NAME = 'de.codex.firefox_bridge';
export const EXTENSION_ID = 'firefox-codex-mcp@local.invalid';
export const REGISTRATION_REVISION = 1;
export const REQUIRED_REGISTRATION_REVISION = Object.freeze({ win: 1, linux: 1, mac: 1 });
export const INSTALLER_VERSION = '1.0.6';
const REGISTRY_PATH = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
const exec = promisify(execFile);
const failure = (code, message) => Object.assign(new Error(message), { code });
const conflict = () => failure('NATIVE_REGISTRATION_CONFLICT', 'Die Native-Host-Registrierung ist fremd, verändert oder nicht sicher zuordenbar und bleibt unverändert.');

function ownWindowsManifestPath(path) {
  return typeof path === 'string' && isAbsolute(path) && !/[\u0000-\u001f\u007f]/u.test(path) && basename(dirname(path)).toLowerCase() === '.local' && basename(path).toLowerCase() === `${HOST_NAME}.json`;
}
function manifestPathFromLauncher(value, platform) {
  const expectedLauncher = platform === 'win' ? 'native-host.cmd' : 'native-host.sh';
  const local = dirname(value.path), manifestPath = join(local, `${HOST_NAME}.json`);
  if ((platform === 'win' ? basename(local).toLowerCase() : basename(local)) !== '.local' || !samePath(value.path, join(local, expectedLauncher), platform)) throw conflict();
  return manifestPath;
}
function registryConflict(current, manifestPath) {
  let message = conflict().message;
  if (typeof current?.value === 'string' && current.value) message += ` Vorhandener Manifestpfad: ${JSON.stringify(current.value)}. Neuer Manifestpfad: ${JSON.stringify(manifestPath)}.`;
  if (current?.exists === true && !current.hasChildren && !current.hasExtraValues && ownWindowsManifestPath(current.value) && !samePath(current.value, manifestPath, 'win')) {
    message += ` Bei einem bewusst verschobenen Projekt kann der vorhandene Pfad mit --replace-native-manifest ${JSON.stringify(current.value)} ausdrücklich ersetzt werden. Vor der Änderung wird eine Sicherung angelegt.`;
  }
  return failure('NATIVE_REGISTRATION_CONFLICT', message);
}

export function registrationPlatform(platform = process.platform) {
  if (platform === 'win32' || platform === 'win') return 'win';
  if (platform === 'darwin' || platform === 'mac') return 'mac';
  if (platform === 'linux') return 'linux';
  throw failure('UNSUPPORTED_PLATFORM', 'Die Native-Host-Registrierung unterstützt Windows, Linux und macOS.');
}
function absolutePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw failure('INVALID_REGISTRATION_PATH', 'Ein eindeutiger absoluter Registrierungspfad wird benötigt.');
  return resolve(value);
}
const samePath = (first, second, platform) => {
  if (typeof first !== 'string' || !isAbsolute(first)) return false;
  return platform === 'win' ? resolve(first).toLowerCase() === resolve(second).toLowerCase() : resolve(first) === resolve(second);
};
export function nativeRegistrationPath({ platform = process.platform, home = homedir() } = {}) {
  platform = registrationPlatform(platform);
  if (platform === 'win') return REGISTRY_PATH;
  home = absolutePath(home);
  return platform === 'linux' ? join(home, '.mozilla', 'native-messaging-hosts', `${HOST_NAME}.json`) : join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts', `${HOST_NAME}.json`);
}
async function safeParents(path) {
  for (let current = dirname(path); ; current = dirname(current)) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw conflict();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
async function regularFile(path) {
  await safeParents(path);
  let before;
  try { before = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536) throw conflict();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw conflict();
    return { bytes: await handle.readFile(), info: opened };
  } finally { await handle.close(); }
}
function manifestValue(file) {
  let value;
  try { value = JSON.parse(file.bytes.toString('utf8')); } catch { throw conflict(); }
  if (!value || value.name !== HOST_NAME || value.type !== 'stdio' || typeof value.description !== 'string' || !isAbsolute(value.path || '') || /[\u0000-\u001f\u007f]/u.test(value.path) || !Array.isArray(value.allowed_extensions) || value.allowed_extensions.length !== 1 || value.allowed_extensions[0] !== EXTENSION_ID || Object.keys(value).some(key => !['name', 'description', 'path', 'type', 'allowed_extensions'].includes(key))) throw conflict();
  return value;
}
function sameManifest(actual, expected, platform) {
  return actual.name === expected.name && actual.type === expected.type && actual.description === expected.description && samePath(actual.path, expected.path, platform) && actual.allowed_extensions[0] === expected.allowed_extensions[0];
}
async function unchanged(path, before) {
  const current = await regularFile(path);
  if (!current || current.info.ino !== before.info.ino || current.info.dev !== before.info.dev || !current.bytes.equals(before.bytes)) throw conflict();
}
async function privateTemp(path, bytes) {
  const temp = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temp).catch(() => {}); throw error; }
  await handle.close();
  return temp;
}
async function publishManifest(path, bytes) {
  await safeParents(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await safeParents(path);
  const temp = await privateTemp(path, bytes);
  try {
    // link publishes the complete file atomically and refuses an existing target.
    await link(temp, path);
  } finally { await unlink(temp); }
}
async function powershell(script, manifestPath, extraEnv = {}) {
  const env = { ...process.env, FIREFOX_MCP_REGISTRATION_MANIFEST: manifestPath, ...extraEnv };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n${script}`], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return result.stdout.trim();
}
function windowsRegistry() {
  const target = `Registry::HKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
  const relative = `Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
  const start = `$ErrorActionPreference='Stop'\n$target='${target}'\n$relative='${relative}'\n`;
  return {
    async read() {
      return JSON.parse(await powershell(start + 'if(Test-Path -LiteralPath $target){$key=Get-Item -LiteralPath $target;try{@{exists=$true;value=$key.GetValue("",$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);hasChildren=$key.SubKeyCount -gt 0;hasExtraValues=@($key.GetValueNames()|Where-Object{$_ -ne ""}).Count -gt 0}|ConvertTo-Json -Compress}finally{$key.Close()}}else{@{exists=$false;hasChildren=$false;hasExtraValues=$false}|ConvertTo-Json -Compress}'));
    },
    async write(manifestPath) {
      await powershell(start + 'if(Test-Path -LiteralPath $target){throw "Registration changed before writing."}\nNew-Item -Path $target -Force | Out-Null\n$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relative,$true)\nif($null -eq $key){throw "Registration disappeared before writing."}\ntry{if($null -ne $key.GetValue("",$null) -or $key.SubKeyCount -gt 0 -or @($key.GetValueNames()|Where-Object{$_ -ne ""}).Count -gt 0){throw "Registration changed before writing."};$key.SetValue("",$env:FIREFOX_MCP_REGISTRATION_MANIFEST,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Close()}', manifestPath);
    },
    async replace(expectedPath, manifestPath) {
      await powershell(start + 'if(-not(Test-Path -LiteralPath $target)){throw "Registration disappeared before replacement."}\n$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($relative,$true)\nif($null -eq $key){throw "Registration disappeared before replacement."}\ntry{$value=$key.GetValue("",$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($value -isnot [string] -or -not [string]::Equals($value,$env:FIREFOX_MCP_REGISTRATION_EXPECTED,[StringComparison]::OrdinalIgnoreCase) -or $key.SubKeyCount -gt 0 -or @($key.GetValueNames()|Where-Object{$_ -ne ""}).Count -gt 0){throw "Registration changed before replacement."};$key.SetValue("",$env:FIREFOX_MCP_REGISTRATION_MANIFEST,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Close()}', manifestPath, { FIREFOX_MCP_REGISTRATION_EXPECTED: expectedPath });
    },
    async remove(manifestPath) {
      await powershell(start + 'if(-not(Test-Path -LiteralPath $target)){exit 0}\n$key=Get-Item -LiteralPath $target\ntry{$value=$key.GetValue("",$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($value -isnot [string] -or -not [string]::Equals($value,$env:FIREFOX_MCP_REGISTRATION_MANIFEST,[StringComparison]::OrdinalIgnoreCase) -or $key.SubKeyCount -gt 0 -or @($key.GetValueNames()|Where-Object{$_ -ne ""}).Count -gt 0){throw "Registration changed before removal."}}finally{$key.Close()}\nRemove-Item -LiteralPath $target -Force', manifestPath);
    }
  };
}
function ownRegistry(current, manifestPath) {
  if (!current || typeof current.exists !== 'boolean' || current.hasChildren || current.hasExtraValues || (current.exists && !samePath(current.value, manifestPath, 'win'))) throw registryConflict(current, manifestPath);
}
async function unchangedOrMissing(path, before) {
  if (before) await unchanged(path, before);
  else if (await regularFile(path)) throw conflict();
}

async function privateRegistrationBackup({ registrationPath, previousManifestPath, manifestPath, previousManifestBytes }) {
  const backupPath = join(dirname(manifestPath), `native-registration-backup-${randomUUID()}.json`);
  await safeParents(backupPath);
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, registrationPath, previousManifestPath, manifestPath, backedUpAt: new Date().toISOString(), ...(previousManifestBytes === undefined ? {} : { previousManifestBase64: previousManifestBytes.toString('base64') }) }, null, 2)}\n`);
  const temp = await privateTemp(backupPath, bytes);
  try {
    if (process.platform === 'win32') {
      await powershell('$ErrorActionPreference="Stop"\n$target=$env:FIREFOX_MCP_REGISTRATION_BACKUP\n$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User\n$systemSid=[System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")\n$acl=[System.Security.AccessControl.FileSecurity]::new()\n$acl.SetAccessRuleProtection($true,$false)\nforeach($identity in @($sid,$systemSid)){$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity,"FullControl","None","None","Allow"))}\n[System.IO.File]::SetAccessControl($target,$acl)', undefined, { FIREFOX_MCP_REGISTRATION_BACKUP: temp });
    }
    await link(temp, backupPath);
  } finally { await unlink(temp); }
  const file = await regularFile(backupPath);
  if (!file || !file.bytes.equals(bytes)) throw failure('NATIVE_REGISTRATION_BACKUP_FAILED', 'Die Sicherung der alten Native-Host-Registrierung konnte nicht bestätigt werden.');
  return { path: backupPath, file };
}

export async function registerNativeHost({ manifestPath, platform = process.platform, home = homedir(), registryAdapter, replaceManifestPath, relocate = false } = {}) {
  manifestPath = absolutePath(manifestPath); platform = registrationPlatform(platform);
  if (replaceManifestPath !== undefined) {
    replaceManifestPath = absolutePath(replaceManifestPath);
    if (platform !== 'win' || !ownWindowsManifestPath(replaceManifestPath) || !ownWindowsManifestPath(manifestPath) || samePath(replaceManifestPath, manifestPath, 'win')) throw failure('INVALID_REGISTRATION_REPLACEMENT', 'Die ausdrückliche Reparatur benötigt unter Windows unterschiedliche absolute Manifestpfade aus der jeweiligen .local-Einrichtung.');
  }
  const registrationPath = nativeRegistrationPath({ platform, home });
  const source = await regularFile(manifestPath);
  if (!source) throw failure('NATIVE_MANIFEST_MISSING', 'Das erzeugte Native-Host-Manifest fehlt. Zuerst das Setup ausführen.');
  const expected = manifestValue(source);
  let changed = false, backupPath, previousManifestPath;
  if (platform === 'win') {
    const registry = registryAdapter || windowsRegistry();
    const current = await registry.read();
    if (replaceManifestPath === undefined && relocate && current?.exists === true && !samePath(current.value, manifestPath, 'win')) {
      if (!ownWindowsManifestPath(current.value) || !ownWindowsManifestPath(manifestPath)) throw registryConflict(current, manifestPath);
      replaceManifestPath = absolutePath(current.value);
    }
    if (replaceManifestPath !== undefined) {
      if (current?.exists !== true || current.hasChildren !== false || current.hasExtraValues !== false || typeof current.value !== 'string' || current.value.toLowerCase() !== replaceManifestPath.toLowerCase()) throw registryConflict(current, manifestPath);
      if (typeof registry.replace !== 'function') throw failure('NATIVE_REGISTRATION_FAILED', 'Der Registrierungsadapter unterstützt keine abgesicherte Native-Host-Reparatur.');
      if (!samePath(manifestPathFromLauncher(expected, 'win'), manifestPath, 'win')) throw registryConflict(current, manifestPath);
      const previous = await regularFile(replaceManifestPath);
      if (previous && !samePath(manifestValue(previous).path, join(dirname(replaceManifestPath), 'native-host.cmd'), 'win')) throw registryConflict(current, manifestPath);
      previousManifestPath = current.value;
      const backup = await privateRegistrationBackup({ registrationPath, previousManifestPath, manifestPath });
      backupPath = backup.path;
      await unchanged(backup.path, backup.file);
      await unchanged(manifestPath, source);
      await unchangedOrMissing(replaceManifestPath, previous);
      await registry.replace(replaceManifestPath, manifestPath);
      changed = true;
    } else {
      ownRegistry(current, manifestPath);
      if (!current.exists) { await registry.write(manifestPath); changed = true; }
    }
    const checked = await registry.read(); ownRegistry(checked, manifestPath);
    if (!checked.exists) throw failure('NATIVE_REGISTRATION_FAILED', 'Die Native-Host-Registrierung konnte nicht bestätigt werden.');
  } else {
    let current = await regularFile(registrationPath);
    if (!current) {
      try { await publishManifest(registrationPath, source.bytes); changed = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      current = await regularFile(registrationPath);
    }
    if (!current) throw conflict();
    const actual = manifestValue(current);
    if (!sameManifest(actual, expected, platform)) {
      if (!relocate || samePath(actual.path, expected.path, platform)) throw conflict();
      previousManifestPath = manifestPathFromLauncher(actual, platform);
      if (!samePath(manifestPathFromLauncher(expected, platform), manifestPath, platform)) throw conflict();
      const previous = await regularFile(previousManifestPath);
      if (previous && !sameManifest(manifestValue(previous), actual, platform)) throw conflict();
      const backup = await privateRegistrationBackup({ registrationPath, previousManifestPath, manifestPath, previousManifestBytes: current.bytes });
      backupPath = backup.path;
      const temp = await privateTemp(registrationPath, source.bytes);
      try {
        await unchanged(backup.path, backup.file);
        await unchanged(manifestPath, source);
        await unchangedOrMissing(previousManifestPath, previous);
        await unchanged(registrationPath, current);
        await rename(temp, registrationPath);
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      changed = true;
      current = await regularFile(registrationPath);
      if (!current || !sameManifest(manifestValue(current), expected, platform)) throw failure('NATIVE_REGISTRATION_FAILED', 'Die reparierte Native-Host-Registrierung konnte nicht bestätigt werden.');
    }
    await unchanged(registrationPath, current);
  }
  await unchanged(manifestPath, source);
  return { platform, manifestPath, registrationPath, changed, registered: true, ...(backupPath === undefined ? {} : { backupPath, previousManifestPath }) };
}

export async function unregisterNativeHost({ manifestPath, platform = process.platform, home = homedir(), registryAdapter, dryRun = false, discover = false } = {}) {
  manifestPath = absolutePath(manifestPath); platform = registrationPlatform(platform);
  const registrationPath = nativeRegistrationPath({ platform, home });
  let changed = false, previousManifestPath;
  if (platform === 'win') {
    const registry = registryAdapter || windowsRegistry();
    const current = await registry.read();
    let discoveredSource;
    if (discover && current?.exists === true) {
      if (current.hasChildren !== false || current.hasExtraValues !== false || !ownWindowsManifestPath(current.value)) throw registryConflict(current, manifestPath);
      previousManifestPath = current.value;
      manifestPath = absolutePath(current.value);
      if (current.value.toLowerCase() !== manifestPath.toLowerCase()) throw registryConflict(current, manifestPath);
      discoveredSource = await regularFile(manifestPath);
      if (discoveredSource && !samePath(manifestValue(discoveredSource).path, join(dirname(manifestPath), 'native-host.cmd'), 'win')) throw registryConflict(current, manifestPath);
    }
    ownRegistry(current, manifestPath);
    if (current.exists) {
      changed = true;
      if (!dryRun) {
        const checked = await registry.read(); ownRegistry(checked, manifestPath);
        if (discover && checked.exists && (checked.hasChildren !== false || checked.hasExtraValues !== false || typeof checked.value !== 'string' || checked.value.toLowerCase() !== manifestPath.toLowerCase())) throw registryConflict(checked, manifestPath);
        if (discover && checked.exists) await unchangedOrMissing(manifestPath, discoveredSource);
        if (checked.exists) await registry.remove(manifestPath);
        if ((await registry.read()).exists) throw failure('NATIVE_REGISTRATION_FAILED', 'Die Native-Host-Deregistrierung konnte nicht bestätigt werden.');
      }
    }
  } else {
    const current = await regularFile(registrationPath);
    if (current) {
      if (discover) {
        const actual = manifestValue(current);
        previousManifestPath = manifestPathFromLauncher(actual, platform);
        manifestPath = previousManifestPath;
      }
      const source = await regularFile(manifestPath);
      let expected;
      if (source) expected = manifestValue(source);
      else if (discover) expected = manifestValue(current);
      else if (basename(dirname(manifestPath)) === '.local' && basename(manifestPath) === `${HOST_NAME}.json`) expected = { name: HOST_NAME, description: 'Lokale Firefox-Brücke für Codex MCP', type: 'stdio', path: join(dirname(manifestPath), 'native-host.sh'), allowed_extensions: [EXTENSION_ID] };
      else throw conflict();
      if (!sameManifest(manifestValue(current), expected, platform)) throw conflict();
      changed = true;
      if (!dryRun) {
        if (discover) await unchangedOrMissing(manifestPath, source);
        await unchanged(registrationPath, current);
        await unlink(registrationPath);
        if (await regularFile(registrationPath)) throw failure('NATIVE_REGISTRATION_FAILED', 'Die Native-Host-Deregistrierung konnte nicht bestätigt werden.');
      }
    }
  }
  return { platform, manifestPath, registrationPath, changed, registered: false, dryRun, ...(previousManifestPath === undefined ? {} : { previousManifestPath }) };
}

export function registrationStatusPath(configPath) { return join(dirname(absolutePath(configPath)), 'registration-status.json'); }
function statusValue(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.registrationRevision) || value.registrationRevision < 1 || typeof value.installerVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.installerVersion) || !['win', 'linux', 'mac'].includes(value.platform) || typeof value.registeredAt !== 'string' || !Number.isFinite(Date.parse(value.registeredAt)) || new Date(value.registeredAt).toISOString() !== value.registeredAt) throw failure('REGISTRATION_STATUS_INVALID', 'Der Registrierungsbeleg ist ungültig.');
  const manifestPath = absolutePath(value.manifestPath);
  if (value.registrationPath !== undefined && (value.platform === 'win' ? value.registrationPath !== REGISTRY_PATH : !isAbsolute(value.registrationPath))) throw failure('REGISTRATION_STATUS_INVALID', 'Der Registrierungspfad im Beleg ist ungültig.');
  return { schemaVersion: 1, registrationRevision: value.registrationRevision, installerVersion: value.installerVersion, registeredAt: value.registeredAt, platform: value.platform, manifestPath, ...(value.registrationPath === undefined ? {} : { registrationPath: value.registrationPath }) };
}
export async function readRegistrationStatus(configPath) {
  try {
    const file = await regularFile(registrationStatusPath(configPath));
    if (!file) return null;
    const value = statusValue(JSON.parse(file.bytes.toString('utf8')));
    return samePath(value.manifestPath, join(dirname(absolutePath(configPath)), `${HOST_NAME}.json`), value.platform) ? value : null;
  } catch { return null; }
}
export async function writeRegistrationStatus(configPath, status) {
  const value = statusValue(status), path = registrationStatusPath(configPath);
  if (!samePath(value.manifestPath, join(dirname(absolutePath(configPath)), `${HOST_NAME}.json`), value.platform)) throw failure('REGISTRATION_STATUS_INVALID', 'Der Registrierungsbeleg gehört nicht zu dieser lokalen Konfiguration.');
  const before = await regularFile(path);
  if (before) {
    try { statusValue(JSON.parse(before.bytes.toString('utf8'))); }
    catch { throw failure('REGISTRATION_STATUS_INVALID', 'Ein fremder oder ungültiger vorhandener Registrierungsbeleg bleibt erhalten.'); }
  }
  await safeParents(path);
  const temp = await privateTemp(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  try {
    if (before) await unchanged(path, before);
    else if (await regularFile(path)) throw conflict();
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return value;
}
export async function removeRegistrationStatus(configPath, { manifestPath, platform = process.platform, registrationPath, dryRun = false } = {}) {
  const path = registrationStatusPath(configPath), file = await regularFile(path);
  if (!file) return false;
  let status;
  try { status = statusValue(JSON.parse(file.bytes.toString('utf8'))); } catch { return false; }
  platform = registrationPlatform(platform);
  if (status.platform !== platform || !samePath(status.manifestPath, absolutePath(manifestPath), platform) || (status.registrationPath !== undefined && status.registrationPath !== registrationPath)) return false;
  if (!dryRun) { await unchanged(path, file); await unlink(path); }
  return true;
}
export function clearRegistrationStatus(configPath, options = {}) {
  return removeRegistrationStatus(configPath, { manifestPath: join(dirname(absolutePath(configPath)), `${HOST_NAME}.json`), registrationPath: nativeRegistrationPath(options), ...options });
}
