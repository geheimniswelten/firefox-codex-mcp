import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export const PAYLOAD_SCHEMA = 1;
const companionFiles = [
  'package.json', 'package-lock.json', 'LICENSE.md', 'README.md', 'PROTOCOL.md',
  'install.ps1', 'scripts/node-runtime.ps1', 'scripts/open-firefox-setup.ps1',
  'scripts/setup.mjs', 'scripts/registration.mjs', 'scripts/install-companion.mjs',
  'scripts/companion-payload.mjs', 'scripts/client-config.mjs', 'scripts/configure-clients.mjs',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validatePayload(payload) {
  if (payload?.schemaVersion !== PAYLOAD_SCHEMA || typeof payload.version !== 'string' || !Array.isArray(payload.files) || payload.files.length > 200) throw new Error('Invalid companion payload.');
  const seen = new Set();
  for (const file of payload.files) {
    if (typeof file.path !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(file.path)) throw new Error('Invalid companion payload path.');
    seen.add(file.path);
    if (typeof file.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new Error('Invalid companion payload data.');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length > 4 * 1024 * 1024 || file.sha256 !== digest(bytes)) throw new Error('Companion payload checksum failed.');
  }
  for (const needed of ['package.json', 'package-lock.json', 'scripts/setup.mjs', 'scripts/install-companion.mjs', 'server/native-host.mjs']) {
    if (!seen.has(needed)) throw new Error('Incomplete companion payload: ' + needed);
  }
  return payload;
}

export async function buildPayload(root) {
  const serverFiles = (await readdir(join(root, 'server'))).filter(name => name.endsWith('.mjs')).map(name => 'server/' + name);
  const files = await Promise.all([...companionFiles, ...serverFiles].sort().map(async path => {
    const bytes = await readFile(join(root, path));
    return { path, sha256: digest(bytes), data: bytes.toString('base64') };
  }));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  return validatePayload({ schemaVersion: PAYLOAD_SCHEMA, version, files });
}

export function encodePayload(payload) {
  const bytes = gzipSync(Buffer.from(JSON.stringify(validatePayload(payload))), { level: 9 });
  return { base64: bytes.toString('base64'), sha256: digest(bytes) };
}

export function decodePayload(base64, sha256) {
  const bytes = Buffer.from(base64, 'base64');
  if (digest(bytes) !== sha256) throw new Error('Companion archive checksum failed.');
  return validatePayload(JSON.parse(gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8')));
}

async function ordinaryPath(path, directory) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || (!directory && info.nlink !== 1)) throw new Error('Setup target is not an ordinary ' + (directory ? 'directory: ' : 'file: ') + path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function extractPayload(payload, root) {
  validatePayload(payload);
  if (!isAbsolute(root) || resolve(root) === dirname(resolve(root))) throw new Error('Choose an absolute installation directory, not a filesystem root.');
  root = resolve(root);
  // Check existing ancestors as well as children: no writes through symlinks.
  const ancestors = [];
  for (let parent = root; dirname(parent) !== parent; parent = dirname(parent)) ancestors.unshift(parent);
  for (const path of ancestors) await ordinaryPath(path, true);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const previous = join(root, 'package.json');
  await ordinaryPath(previous, false);
  try {
    const installed = JSON.parse(await readFile(previous, 'utf8'));
    if (installed.name !== 'firefox-codex-mcp') throw new Error('Installation directory belongs to another application.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Validate every destination before touching existing project files.
  for (const file of payload.files) {
    const target = resolve(root, file.path);
    if (relative(root, target).startsWith('..' + sep)) throw new Error('Payload path escaped installation directory.');
    const pieces = file.path.split('/');
    let parent = root;
    for (const part of pieces.slice(0, -1)) { parent = join(parent, part); await ordinaryPath(parent, true); }
    await ordinaryPath(target, false);
  }
  for (const file of payload.files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, Buffer.from(file.data, 'base64'), { mode: 0o600 });
  }
  return root;
}
