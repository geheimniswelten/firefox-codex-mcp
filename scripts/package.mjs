import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const excluded = new Set(['node_modules', '.runtime', '.local', 'dist', '.git', 'coverage', 'work']);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

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

// Standard ZIP using STORE entries: no runtime archiver dependency, UTF-8 names,
// stable timestamps, and CRC-32 checked by ordinary unzip tools.
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    if (name.length > 65535 || file.data.length > 0xffffffff) throw new Error('ZIP64 wird nicht unterstützt.');
    const crc = crc32(file.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); // 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(file.data.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, file.data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(file.data.length, 20);
    record.writeUInt32LE(file.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + file.data.length;
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  if (files.length > 65535 || offset > 0xffffffff || centralSize > 0xffffffff) throw new Error('ZIP64 wird nicht unterstützt.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

try {
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
