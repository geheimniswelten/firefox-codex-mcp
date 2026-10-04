import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSetupDownloads } from './build-setup-downloads.mjs';
import { zip } from './package-zip.mjs';
import { buildHtmlVendor } from './single-file-build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const excluded = new Set(['node_modules', '.runtime', '.local', 'dist', '.git', 'coverage', 'work']);

async function collect(base, directory = base) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (excluded.has(entry.name) || entry.name.startsWith('.env') || /\.(log|pem|key|pfx)$/iu.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(base, path));
    else if (entry.isFile()) files.push({ name: relative(base, path).split(sep).join('/'), data: await readFile(path) });
  }
  return files;
}

try {
  await buildHtmlVendor(root);
  await buildSetupDownloads(root);
  await mkdir(dist, { recursive: true });
  const extensionFiles = await collect(join(root, 'extension'));
  if (!extensionFiles.some(file => file.name === 'manifest.json')) throw new Error('Erweiterungsmanifest fehlt.');
  await writeFile(join(dist, 'firefox-codex-mcp-extension.zip'), zip(extensionFiles));
  const sourceFiles = await collect(root);
  if (!sourceFiles.some(file => file.name === 'package-lock.json')) throw new Error('Lockdatei fehlt.');
  await writeFile(join(dist, 'firefox-codex-mcp-source.zip'), zip(sourceFiles));
  console.log(`Pakete erstellt in ${dist}\nErweiterung: ${extensionFiles.length} Dateien; Quellpaket: ${sourceFiles.length} Dateien.\nDie Erweiterung ist unsigniert; .local, .runtime und node_modules sind ausgeschlossen.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
