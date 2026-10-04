import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSetup } from './setup.mjs';
import { unregisterNativeHost } from './registration.mjs';

export function defaultInstallationRoot(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'FirefoxCodexMCP');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'FirefoxCodexMCP');
  if (platform === 'linux') return join(home, '.local', 'share', 'firefox-codex-mcp');
  throw new Error('This setup supports Windows, Linux and macOS.');
}

export function parseInstallArgs(args) {
  const options = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') {
      if (!args[i + 1] || !isAbsolute(args[i + 1])) throw new Error('--root needs an absolute installation directory.');
      options.root = resolve(args[++i]);
    } else if (args[i] === '--remove') options.remove = true;
    else if (args[i] === '--no-register-clients') options.noClients = true;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--port') {
      const value = args[++i];
      if (!/^[0-9]+$/.test(value || '') || Number(value) < 1024 || Number(value) > 65535) throw new Error('--port must be between 1024 and 65535.');
      options.port = Number(value);
    } else if (args[i] === '--help') options.help = true;
    else throw new Error('Unknown setup option: ' + args[i]);
  }
  if (options.remove && options.port !== undefined) throw new Error('--port cannot be used with --remove.');
  return options;
}

async function configureInstalledClients(root, remove) {
  try {
    const { configureClients } = await import('./client-config.mjs');
    const results = await configureClients({ root, remove });
    for (const item of results) console.log(item.label + ': ' + item.status + (item.message ? ' - ' + item.message : ''));
    return results.some(item => ['conflict', 'error'].includes(item.status)) ? 2 : 0;
  } catch {
    console.error('Native-Host-Vorgang abgeschlossen; KI-Client-Eintraege konnten nicht bearbeitet werden. Vorhandene Konfigurationen bleiben erhalten.');
    return 2;
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseInstallArgs(args);
  if (options.help) { console.log('node scripts/install-companion.mjs [--root ABS] [--port 38477] [--no-register-clients] [--remove] [--dry-run]'); return 0; }
  const manifestPath = join(options.root, '.local', 'de.codex.firefox_bridge.json');
  if (options.remove) {
    // Do not install dependencies or delete the application during deregistration.
    const result = await unregisterNativeHost({ manifestPath, dryRun: options.dryRun });
    console.log(options.dryRun ? 'Deregistrierung geprueft; keine Aenderung.' : 'Native Host deregistriert. Dateien und Einstellungen bleiben erhalten.');
    if (!options.dryRun) {
      const { clearRegistrationStatus } = await import('./registration.mjs');
      await clearRegistrationStatus(join(options.root, '.local', 'config.json'));
    }
    return options.noClients || options.dryRun ? 0 : configureInstalledClients(options.root, true);
  }
  if (options.dryRun) { console.log('Installation nach ' + options.root + '; keine Aenderung.'); return 0; }
  const installed = JSON.parse(await readFile(join(options.root, 'package.json'), 'utf8'));
  if (installed.name !== 'firefox-codex-mcp') throw new Error('Unexpected installation package.');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error('Node.js 22 or newer is required.');
  // Unix wrapper uses the existing Node runtime; Windows uses install.ps1.
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  let command, commandArgs;
  try { await access(npmCli); command = process.execPath; commandArgs = [npmCli, 'ci', '--omit=dev']; }
  catch { command = 'npm'; commandArgs = ['ci', '--omit=dev']; }
  const npm = spawnSync(command, commandArgs, { cwd: options.root, stdio: 'inherit', windowsHide: true });
  if (npm.error || npm.status !== 0) throw new Error('npm ci failed; Native Host was not registered.');
  const result = await prepareSetup({ root: options.root, ...(options.port === undefined ? {} : { port: options.port }), register: true });
  console.log('Native Host registriert: ' + result.manifestPath);
  console.log('Firefox-Verbindung jetzt erneut pruefen; temporaeres Laden bleibt fuer Entwicklung moeglich.');
  return options.noClients ? 0 : configureInstalledClients(options.root, false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
