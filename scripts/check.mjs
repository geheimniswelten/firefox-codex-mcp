import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['node_modules', '.local', 'dist', '.git', 'coverage']);
async function checkTree(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await checkTree(path);
    else if (entry.isFile() && /\.(?:mjs|js)$/u.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', windowsHide: true });
      if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
      count++;
    }
  }
  return count;
}

try {
  const count = await checkTree(root);
  const manifest = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'));
  if (![2, 3].includes(manifest.manifest_version)) throw new Error('Ungültige Manifestversion.');
  if (manifest.browser_specific_settings?.gecko?.id !== 'firefox-codex-mcp@local.invalid') throw new Error('Die Erweiterungs-ID passt nicht zum Native Host.');
  if (parseFloat(manifest.browser_specific_settings.gecko.strict_min_version) < 139) throw new Error('Tabgruppen benötigen Firefox 139 oder neuer.');
  for (const permission of ['tabs', 'tabGroups', 'nativeMessaging', 'sessions', 'management']) {
    if (!manifest.permissions?.includes(permission)) throw new Error(`Berechtigung fehlt: ${permission}`);
  }
  if (manifest.manifest_version === 3 && !manifest.permissions?.includes('scripting')) throw new Error('Manifest V3 benötigt die scripting-Berechtigung.');
  const backgroundFiles = manifest.background?.scripts || (manifest.background?.page ? [manifest.background.page] : []);
  if (!backgroundFiles.length) throw new Error('Firefox-Hintergrundskript fehlt.');
  for (const path of backgroundFiles) await readFile(join(root, 'extension', path));
  JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  console.log(`Syntax von ${count} JavaScript-Dateien und Manifest geprüft.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
