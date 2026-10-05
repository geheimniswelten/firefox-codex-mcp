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
export const INSTALLER_VERSION = '1.0.5';
const REGISTRY_PATH = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
const exec = promisify(execFile);
const failure = (code, message) => Object.assign(new Error(message), { code });
const conflict = () => failure('NATIVE_REGISTRATION_CONFLICT', 'Die Native-Host-Registrierung ist fremd, verändert oder nicht sicher zuordenbar und bleibt unverändert.');

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
async function powershell(script, manifestPath) {
  const env = { ...process.env, FIREFOX_MCP_REGISTRATION_MANIFEST: manifestPath };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n${script}`], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return result.stdout.trim();
}
function windowsRegistry() {
  const target = `Registry::HKEY_CURRENT_USER\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
  const start = `$ErrorActionPreference='Stop'\n$target='${target}'\n`;
  return {
    async read() {
      return JSON.parse(await powershell(start + 'if(Test-Path -LiteralPath $target){$key=Get-Item -LiteralPath $target;try{@{exists=$true;value=$key.GetValue("",$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);hasChildren=$key.SubKeyCount -gt 0}|ConvertTo-Json -Compress}finally{$key.Close()}}else{@{exists=$false;hasChildren=$false}|ConvertTo-Json -Compress}'));
    },
    async write(manifestPath) {
      await powershell(start + 'if(Test-Path -LiteralPath $target){throw "Registration changed before writing."}\nNew-Item -Path $target -Force | Out-Null\n$key=Get-Item -LiteralPath $target\ntry{if($null -ne $key.GetValue("",$null) -or $key.SubKeyCount -gt 0){throw "Registration changed before writing."};$key.SetValue("",$env:FIREFOX_MCP_REGISTRATION_MANIFEST,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Close()}', manifestPath);
    },
    async remove(manifestPath) {
      await powershell(start + 'if(-not(Test-Path -LiteralPath $target)){exit 0}\n$key=Get-Item -LiteralPath $target\ntry{$value=$key.GetValue("",$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);if($value -isnot [string] -or -not [string]::Equals([IO.Path]::GetFullPath($value),$env:FIREFOX_MCP_REGISTRATION_MANIFEST,[StringComparison]::OrdinalIgnoreCase) -or $key.SubKeyCount -gt 0){throw "Registration changed before removal."}}finally{$key.Close()}\nRemove-Item -LiteralPath $target -Force', manifestPath);
    }
  };
}
function ownRegistry(current, manifestPath) {
  if (!current || typeof current.exists !== 'boolean' || current.hasChildren || (current.exists && !samePath(current.value, manifestPath, 'win'))) throw conflict();
}

export async function registerNativeHost({ manifestPath, platform = process.platform, home = homedir(), registryAdapter } = {}) {
  manifestPath = absolutePath(manifestPath); platform = registrationPlatform(platform);
  const registrationPath = nativeRegistrationPath({ platform, home });
  const source = await regularFile(manifestPath);
  if (!source) throw failure('NATIVE_MANIFEST_MISSING', 'Das erzeugte Native-Host-Manifest fehlt. Zuerst das Setup ausführen.');
  const expected = manifestValue(source);
  let changed = false;
  if (platform === 'win') {
    const registry = registryAdapter || windowsRegistry();
    const current = await registry.read(); ownRegistry(current, manifestPath);
    if (!current.exists) { await registry.write(manifestPath); changed = true; }
    const checked = await registry.read(); ownRegistry(checked, manifestPath);
    if (!checked.exists) throw failure('NATIVE_REGISTRATION_FAILED', 'Die Native-Host-Registrierung konnte nicht bestätigt werden.');
  } else {
    let current = await regularFile(registrationPath);
    if (!current) {
      try { await publishManifest(registrationPath, source.bytes); changed = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      current = await regularFile(registrationPath);
    }
    if (!current || !sameManifest(manifestValue(current), expected, platform)) throw conflict();
    await unchanged(registrationPath, current);
  }
  await unchanged(manifestPath, source);
  return { platform, manifestPath, registrationPath, changed, registered: true };
}

export async function unregisterNativeHost({ manifestPath, platform = process.platform, home = homedir(), registryAdapter, dryRun = false } = {}) {
  manifestPath = absolutePath(manifestPath); platform = registrationPlatform(platform);
  const registrationPath = nativeRegistrationPath({ platform, home });
  let changed = false;
  if (platform === 'win') {
    const registry = registryAdapter || windowsRegistry();
    const current = await registry.read(); ownRegistry(current, manifestPath);
    if (current.exists) {
      changed = true;
      if (!dryRun) {
        const checked = await registry.read(); ownRegistry(checked, manifestPath);
        if (checked.exists) await registry.remove(manifestPath);
        if ((await registry.read()).exists) throw failure('NATIVE_REGISTRATION_FAILED', 'Die Native-Host-Deregistrierung konnte nicht bestätigt werden.');
      }
    }
  } else {
    const current = await regularFile(registrationPath);
    if (current) {
      const source = await regularFile(manifestPath);
      let expected;
      if (source) expected = manifestValue(source);
      else if (basename(dirname(manifestPath)) === '.local' && basename(manifestPath) === `${HOST_NAME}.json`) expected = { name: HOST_NAME, description: 'Lokale Firefox-Brücke für Codex MCP', type: 'stdio', path: join(dirname(manifestPath), 'native-host.sh'), allowed_extensions: [EXTENSION_ID] };
      else throw conflict();
      if (!sameManifest(manifestValue(current), expected, platform)) throw conflict();
      changed = true;
      if (!dryRun) {
        await unchanged(registrationPath, current);
        await unlink(registrationPath);
        if (await regularFile(registrationPath)) throw failure('NATIVE_REGISTRATION_FAILED', 'Die Native-Host-Deregistrierung konnte nicht bestätigt werden.');
      }
    }
  }
  return { platform, manifestPath, registrationPath, changed, registered: false, dryRun };
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
