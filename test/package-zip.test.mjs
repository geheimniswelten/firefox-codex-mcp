import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { zip } from '../scripts/package-zip.mjs';

// Read the archive through its central directory, then inflate the recorded
// byte ranges independently of the writer. This also exercises entry offsets.
function readArchive(archive) {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  const count = archive.readUInt16LE(end + 10), entries = [];
  let cursor = archive.readUInt32LE(end + 16);
  const start = cursor;
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    assert.equal(archive.readUInt16LE(cursor + 8), 0x800);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16), size = archive.readUInt32LE(cursor + 20);
    const originalSize = archive.readUInt32LE(cursor + 24), nameLength = archive.readUInt16LE(cursor + 28);
    const offset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(archive.readUInt32LE(offset), 0x04034b50);
    assert.equal(archive.readUInt16LE(offset + 8), method);
    assert.equal(archive.readUInt32LE(offset + 14), crc);
    assert.equal(archive.readUInt32LE(offset + 18), size);
    const bodyOffset = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    const body = archive.subarray(bodyOffset, bodyOffset + size);
    const data = method === 8 ? inflateRawSync(body) : body;
    assert.equal(data.length, originalSize);
    entries.push({ name, data, method, crc });
    cursor += 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor - start, archive.readUInt32LE(end + 12));
  assert.equal(cursor, end);
  return entries;
}

test('ZIP preserves text, binary and empty entries with DEFLATE, STORE and UTF-8 names', () => {
  const files = [
    { name: 'manifest.json', data: Buffer.from('{"version":"1.0.2"}\n'.repeat(300)) },
    { name: 'Grüße/空.txt', data: Buffer.from('123456789') },
    { name: 'empty', data: Buffer.alloc(0) },
    { name: 'binary', data: Buffer.from([0, 255, 1, 254, 2, 253]) },
  ];
  const archive = zip(files), entries = readArchive(archive);
  assert.ok(archive.length < 1000, 'the text entry must actually be compressed');
  assert.equal(entries[0].method, 8);
  assert.equal(entries[1].method, 0);
  assert.equal(entries[1].crc, 0xcbf43926, 'standard CRC-32 check vector');
  assert.equal(entries[2].method, 0);
  assert.deepEqual(entries.map(({ name, data }) => ({ name, data })), files);
});

test('ZIP output is deterministic across builds and supports an empty archive', () => {
  const files = [{ name: 'source.js', data: Buffer.from('const stable = true;\n'.repeat(100)) }];
  assert.deepEqual(zip(files), zip(files));
  assert.deepEqual(readArchive(zip([])), []);
});

test('ZIP rejects unsupported entry counts and UTF-8 filename lengths', () => {
  assert.throws(() => zip(new Array(65536)), /ZIP64/u);
  assert.throws(() => zip([{ name: '空'.repeat(22000), data: Buffer.alloc(0) }]), /ZIP64/u);
});
