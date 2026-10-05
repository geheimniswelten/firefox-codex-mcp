#!/bin/sh
# Companion 1.0.6; registration revision 1.
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
firefox_script_dir=$(CDPATH='' cd -P "$(dirname "$0")" && pwd)
node --input-type=module - "$firefox_root" "$firefox_no_clients" "$firefox_script_dir" <<'FIREFOX_DEREGISTER_JS'
import { readFile, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
const host = 'de.codex.firefox_bridge';
const home = homedir();
const registrationPath = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts', host + '.json') : process.platform === 'linux' ? join(home, '.mozilla', 'native-messaging-hosts', host + '.json') : null;
if (!registrationPath) throw new Error('This script supports Linux and macOS.');
async function ordinary(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Unexpected linked or non-file path: ' + path);
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
let registered, original;
original = await ordinary(registrationPath);
if (original !== null) registered = JSON.parse(original);
const requestedRoot = process.argv[2], scriptDirectory = process.argv[4];
let root;
if (original !== null) {
  if (registered?.name !== host || registered.type !== 'stdio' || registered.allowed_extensions?.length !== 1 || registered.allowed_extensions[0] !== 'firefox-codex-mcp@local.invalid' || typeof registered.path !== 'string' || !isAbsolute(registered.path) || basename(dirname(registered.path)) !== '.local' || basename(registered.path) !== 'native-host.sh') throw new Error('Registration does not identify this companion; nothing removed.');
  root = dirname(dirname(registered.path));
  if (resolve(root) === dirname(resolve(root)) || registered.path !== join(root, '.local', 'native-host.sh')) throw new Error('Registration belongs to an unsafe directory; nothing removed.');
  // A saved new directory never overrides the installation in the manifest.
  if (await ordinary(registrationPath) !== original) throw new Error('Registration changed; nothing removed.');
  await unlink(registrationPath);
} else {
  root = requestedRoot || (await ordinary(join(scriptDirectory, 'scripts', 'client-config.mjs')) !== null ? scriptDirectory : null)
    || (basename(scriptDirectory) === 'scripts' && await ordinary(join(scriptDirectory, 'client-config.mjs')) !== null ? dirname(scriptDirectory) : null)
    || (process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'FirefoxCodexMCP') : join(home, '.local', 'share', 'firefox-codex-mcp'));
  if (!isAbsolute(root) || resolve(root) === dirname(resolve(root))) throw new Error('Supply --root ABSOLUTE_DIRECTORY for the companion to deregister.');
  root = resolve(root);
}
const receiptPath = join(root, '.local', 'registration-status.json');
try {
  const text = await ordinary(receiptPath);
  const receipt = text === null ? null : JSON.parse(text);
  if (receipt?.schemaVersion === 1 && receipt.platform === (process.platform === 'darwin' ? 'mac' : 'linux') && Number.isSafeInteger(receipt.registrationRevision) && receipt.registrationRevision >= 1 && typeof receipt.installerVersion === 'string' && /^\d+\.\d+\.\d+$/.test(receipt.installerVersion) && typeof receipt.registeredAt === 'string' && Number.isFinite(Date.parse(receipt.registeredAt)) && new Date(receipt.registeredAt).toISOString() === receipt.registeredAt && receipt.manifestPath === join(root, '.local', host + '.json') && (receipt.registrationPath === undefined || receipt.registrationPath === registrationPath)) {
    if (await ordinary(receiptPath) !== text) throw new Error('Registration receipt changed; it was kept.');
    await unlink(receiptPath);
  }
} catch (error) { console.error('Native Host deregistered; registration receipt was kept: ' + error.message); process.exitCode = 2; }
console.log('Native Host deregistered. Companion files and settings are kept.');
if (!process.argv[3]) {
  try {
    const candidates = [join(scriptDirectory, 'scripts/client-config.mjs'), ...(basename(scriptDirectory) === 'scripts' ? [join(scriptDirectory, 'client-config.mjs')] : []), join(root, 'scripts/client-config.mjs')];
    if (requestedRoot && isAbsolute(requestedRoot)) candidates.push(join(resolve(requestedRoot), 'scripts/client-config.mjs'));
    let registrar;
    for (const candidate of candidates) { if (await ordinary(candidate) !== null) { registrar = candidate; break; } }
    if (!registrar) throw new Error('A current client registrar is missing.');
    const { configureClients } = await import(pathToFileURL(registrar).href);
    const results = await configureClients({ root, remove: true, discover: true });
    for (const result of results) console.log(result.label + ': ' + result.status);
    if (results.some(item => ['error', 'conflict'].includes(item.status))) process.exitCode = 2;
  } catch { console.error('AI client entries could not be checked. Companion registration was removed.'); process.exitCode = 2; }
}
console.log('Return to the extension settings and choose Check again.');
FIREFOX_DEREGISTER_JS
