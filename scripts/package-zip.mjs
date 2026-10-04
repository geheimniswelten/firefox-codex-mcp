import { deflateRawSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Ordinary ZIP entries with UTF-8 names and stable 1980-01-01 timestamps.
// DEFLATE reduces upload size; already compressed files use STORE when smaller.
export function zip(files) {
  if (files.length > 65535) throw new Error('ZIP64 wird nicht unterstützt.');
  const locals = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'), data = file.data;
    if (name.length > 65535 || data.length > 0xffffffff) throw new Error('ZIP64 wird nicht unterstützt.');
    const compressed = deflateRawSync(data, { level: 6 });
    const method = compressed.length < data.length ? 8 : 0;
    const packed = method === 8 ? compressed : data, crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + packed.length;
    if (offset > 0xffffffff) throw new Error('ZIP64 wird nicht unterstützt.');
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  if (centralSize > 0xffffffff) throw new Error('ZIP64 wird nicht unterstützt.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
