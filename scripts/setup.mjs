import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { HOST_NAME, EXTENSION_ID, REGISTRATION_REVISION, INSTALLER_VERSION, registerNativeHost, unregisterNativeHost, writeRegistrationStatus, removeRegistrationStatus } from './registration.mjs';

export { HOST_NAME, EXTENSION_ID };
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  if (command === 'powershell.exe') {
    // A parent PowerShell 7 can supply its incompatible module directories to
    // Windows PowerShell 5.1. Let the child discover its own built-in modules.
    const env = { ...(options.env || process.env) };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    options = { ...options, env };
  }
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} fehlgeschlagen: ${result.error?.message || result.stderr?.trim() || result.status}`);
  }
  return result.stdout.trim();
}

export function tomlLiteral(value) {
  if (/[\r\n\u0000]/u.test(value)) throw new Error('Unzulässiges Zeichen in einem Konfigurationspfad.');
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("'''")) return `'''${value}'''`;
  throw new Error('Der Pfad enthält drei aufeinanderfolgende Apostrophe und kann nicht als TOML-Literal geschrieben werden.');
}

async function rejectSymlink(path, directory = false) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Unsicherer oder unpassender Dateityp: ${path}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function protect(path, directory = false) {
  if (process.platform !== 'win32') {
    await chmod(path, directory ? 0o700 : 0o600);
    return;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$target = $env:FIREFOX_MCP_PRIVATE_PATH',
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")',
    '$isDirectory = $env:FIREFOX_MCP_PRIVATE_DIR -eq "1"',
    '$acl = if ($isDirectory) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$inheritance = [System.Security.AccessControl.InheritanceFlags]::None',
    'if ($env:FIREFOX_MCP_PRIVATE_DIR -eq "1") { $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }',
    'foreach ($identity in @($sid, $systemSid)) { $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, "FullControl", $inheritance, "None", "Allow")) }',
    'if ($isDirectory) { [System.IO.Directory]::SetAccessControl($target, $acl) } else { [System.IO.File]::SetAccessControl($target, $acl) }',
  ].join('\n');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, FIREFOX_MCP_PRIVATE_PATH: path, FIREFOX_MCP_PRIVATE_DIR: directory ? '1' : '0' },
  });
}

async function writePrivate(path, content, executable = false) {
  await rejectSymlink(path);
  await writeFile(path, content, { mode: executable ? 0o700 : 0o600 });
  await protect(path);
  if (executable && process.platform !== 'win32') await chmod(path, 0o700);
}

function validateConfig(value) {
  if (!value || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      typeof value.token !== 'string' || !/^[a-f0-9]{64}$/u.test(value.token)) {
    throw new Error('Vorhandene .local/config.json ist ungültig; sie wurde nicht überschrieben.');
  }
}

export function assertRegistrationCompatible(existingPath, manifestPath, platform = process.platform) {
  if (existingPath === undefined) return;
  if (typeof existingPath !== 'string' || existingPath.length === 0) {
    throw new Error('Es besteht bereits eine Native-Messaging-Registrierung ohne gültigen Manifestpfad.');
  }
  const normalize = value => platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (normalize(existingPath) !== normalize(manifestPath)) {
    throw new Error(`Native-Messaging-Host ist bereits anders registriert (${existingPath}). Bestehende Registrierung bleibt unverändert.`);
  }
}

export async function prepareSetup({ root = defaultRoot, nodePath = process.execPath, port, register = false, platform = process.platform, home, registryAdapter, now = Date.now } = {}) {
  root = resolve(root);
  if (!isAbsolute(nodePath)) throw new Error('Node-Pfad muss absolut sein.');
  if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error('Port muss eine ganze Zahl zwischen 1024 und 65535 sein.');
  }
  const local = join(root, '.local');
  await rejectSymlink(local, true);
  await mkdir(local, { recursive: true, mode: 0o700 });
  await protect(local, true);
  const configPath = join(local, 'config.json');
  await rejectSymlink(configPath);
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
    validateConfig(config);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = { port: 38477, token: randomBytes(32).toString('hex') };
  }
  if (port !== undefined) config.port = port;
  await writePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const nativePath = join(root, 'server', 'native-host.mjs');
  const mcpPath = join(root, 'server', 'mcp.mjs');
  const launcherPath = join(local, process.platform === 'win32' ? 'native-host.cmd' : 'native-host.sh');
  let launcher;
  if (process.platform === 'win32') {
    for (const path of [nodePath, nativePath, configPath]) {
      if (/["\r\n%]/u.test(path)) throw new Error('Windows-Startpfade dürfen weder Anführungszeichen noch Prozentzeichen oder Zeilenumbrüche enthalten.');
    }
    launcher = `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${nodePath}" "${nativePath}" --config "${configPath}"\r\n`;
  } else {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    launcher = `#!/bin/sh\nexec ${quote(nodePath)} ${quote(nativePath)} --config ${quote(configPath)}\n`;
  }
  await writePrivate(launcherPath, launcher, true);
  const manifestPath = join(local, `${HOST_NAME}.json`);
  await writePrivate(manifestPath, `${JSON.stringify({
    name: HOST_NAME,
    description: 'Lokale Firefox-Brücke für Codex MCP',
    path: launcherPath,
    type: 'stdio',
    allowed_extensions: [EXTENSION_ID],
  }, null, 2)}\n`);
  const codexPath = join(local, 'codex-config.toml');
  await writePrivate(codexPath, [
    '# Diesen Abschnitt in die bestehende Codex-Konfiguration übernehmen.',
    '# Einen bereits vorhandenen gleichnamigen Abschnitt vorher prüfen.',
    '[mcp_servers.firefox]',
    `command = ${tomlLiteral(nodePath)}`,
    `args = [${[mcpPath, '--config', configPath].map(tomlLiteral).join(', ')}]`,
    'startup_timeout_sec = 15',
    'tool_timeout_sec = 180',
    '',
  ].join('\n'));
  let registration = null, registrationStatus = null;
  if (register) {
    registration = await registerNativeHost({ manifestPath, platform, home, registryAdapter });
    registrationStatus = await writeRegistrationStatus(configPath, { schemaVersion: 1, registrationRevision: REGISTRATION_REVISION, installerVersion: INSTALLER_VERSION, registeredAt: new Date(now()).toISOString(), platform: registration.platform, manifestPath, registrationPath: registration.registrationPath });
  }
  return { local, configPath, manifestPath, launcherPath, codexPath, port: config.port, registered: register, registrationPath: registration?.registrationPath ?? null, registrationStatus };
}

export async function unregisterSetup({ root = defaultRoot, platform = process.platform, home, registryAdapter, dryRun = false } = {}) {
  root = resolve(root);
  const local = join(root, '.local'), configPath = join(local, 'config.json'), manifestPath = join(local, `${HOST_NAME}.json`);
  const result = await unregisterNativeHost({ manifestPath, platform, home, registryAdapter, dryRun });
  const statusRemoved = await removeRegistrationStatus(configPath, { ...result, dryRun });
  return { ...result, local, configPath, statusRemoved };
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  let unregister = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--register-native') options.register = true;
    else if (arg === '--unregister-native') unregister = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--root') {
      const value = args[++index];
      if (!value || !isAbsolute(value)) throw new Error('--root erwartet einen absoluten Projektpfad.');
      options.root = value;
    }
    else if (arg === '--port') {
      const raw = args[++index];
      if (!raw || !/^\d+$/u.test(raw)) throw new Error('--port erwartet eine Portnummer.');
      options.port = Number(raw);
    } else if (arg === '--help') {
      console.log('node scripts/setup.mjs [--root ABSOLUTER_PFAD] [--port 38477] [--register-native]\nnode scripts/setup.mjs [--root ABSOLUTER_PFAD] --unregister-native [--dry-run]\nOhne --register-native werden ausschließlich Projektdateien erzeugt.');
      return;
    } else throw new Error(`Unbekannte Option: ${arg}`);
  }
  if (unregister) {
    if (options.register || options.port !== undefined) throw new Error('--unregister-native darf nicht mit Registrierung oder --port kombiniert werden.');
    const result = await unregisterSetup(options);
    console.log(`${result.dryRun ? 'Vorschau: ' : ''}Native-Host-Registrierung ${result.changed ? result.dryRun ? 'würde entfernt' : 'entfernt' : 'nicht vorhanden'}.\nRegistrierungspfad: ${result.registrationPath}\nProjektdateien und KI-Client-Konfigurationen bleiben erhalten.`);
    return result;
  }
  if (options.dryRun) throw new Error('--dry-run ist nur mit --unregister-native möglich.');
  const result = await prepareSetup(options);
  console.log(`Lokale Konfiguration: ${result.configPath}\nCodex-Konfigurationsvorlage: ${result.codexPath}\nNative-Host-Manifest: ${result.manifestPath}\nPort: ${result.port}\nNative Host registriert: ${result.registered ? 'ja' : 'nein'}\nFirefox-Erweiterung danach laden bzw. neu laden. KI-Clients: scripts/configure-clients.mjs (wird von install.ps1 automatisch ausgefuehrt).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
