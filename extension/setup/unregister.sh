#!/bin/sh
# Companion 1.0.5; registration revision 1.
set -eu
firefox_root=''
firefox_no_clients=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) [ "$#" -ge 2 ] || { echo '--root needs a directory.' >&2; exit 1; }; firefox_root=$2; shift 2 ;;
    --no-register-clients) firefox_no_clients='--no-register-clients'; shift ;;
    --help) echo 'sh unregister.sh [--root ABSOLUTE_DIRECTORY] [--no-register-clients]'; echo 'Removes registration; companion files and settings are kept. Requires Node.js 22+.'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
command -v node >/dev/null 2>&1 || { echo 'Node.js 22+ is required.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' || { echo 'Node.js 22+ is required.' >&2; exit 1; }
node --input-type=module - "$firefox_root" "$firefox_no_clients" <<'FIREFOX_DEREGISTER_JS'
import { readFile, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const host = 'de.codex.firefox_bridge';
const home = homedir();
const registrationPath = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts', host + '.json') : process.platform === 'linux' ? join(home, '.mozilla', 'native-messaging-hosts', host + '.json') : null;
if (!registrationPath) throw new Error('This script supports Linux and macOS.');
let registered, original;
try {
  const info = await lstat(registrationPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unexpected registration file; nothing removed.');
  original = await readFile(registrationPath, 'utf8');
  registered = JSON.parse(original);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
let root = process.argv[2];
if (!root && registered?.path && isAbsolute(registered.path) && basename(dirname(registered.path)) === '.local' && basename(registered.path) === 'native-host.sh') root = dirname(dirname(registered.path));
if (!root || !isAbsolute(root) || resolve(root) === dirname(resolve(root))) throw new Error('Supply --root ABSOLUTE_DIRECTORY for the companion to deregister.');
root = resolve(root);
if (registered) {
  if (registered.name !== host || registered.type !== 'stdio' || registered.allowed_extensions?.length !== 1 || registered.allowed_extensions[0] !== 'firefox-codex-mcp@local.invalid' || registered.path !== join(root, '.local', 'native-host.sh')) throw new Error('Registration belongs to another installation; nothing removed.');
  if ((await lstat(registrationPath)).isSymbolicLink() || await readFile(registrationPath, 'utf8') !== original) throw new Error('Registration changed; nothing removed.');
  await unlink(registrationPath);
}
const receiptPath = join(root, '.local', 'registration-status.json');
try {
  const info = await lstat(receiptPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unexpected registration receipt.');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (receipt.manifestPath === join(root, '.local', host + '.json') && receipt.registrationPath === registrationPath) await unlink(receiptPath);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log('Native Host deregistered. Companion files and settings are kept.');
if (!process.argv[3]) {
  try {
    const { configureClients } = await import(pathToFileURL(join(root, 'scripts/client-config.mjs')).href);
    const results = await configureClients({ root, remove: true });
    for (const result of results) console.log(result.label + ': ' + result.status);
    if (results.some(item => ['error', 'conflict'].includes(item.status))) process.exitCode = 2;
  } catch { console.error('AI client entries could not be checked. Companion registration was removed.'); process.exitCode = 2; }
}
console.log('Return to the extension settings and choose Check again.');
FIREFOX_DEREGISTER_JS
