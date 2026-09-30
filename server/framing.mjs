import { endianness } from 'node:os';

export const MAX_NATIVE_BYTES = 900_000;
const little = endianness() === 'LE';

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_NATIVE_BYTES) throw new Error('Native message exceeds size limit.');
  const header = Buffer.alloc(4);
  if (little) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export class NativeDecoder {
  #buffer = Buffer.alloc(0);
  constructor(onMessage) { this.onMessage = onMessage; }
  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const size = little ? this.#buffer.readUInt32LE(0) : this.#buffer.readUInt32BE(0);
      if (size === 0 || size > MAX_NATIVE_BYTES) throw new Error('Invalid native message length.');
      if (this.#buffer.length < size + 4) return;
      const message = JSON.parse(this.#buffer.subarray(4, size + 4).toString('utf8'));
      this.#buffer = this.#buffer.subarray(size + 4);
      this.onMessage(message);
    }
  }
  finish() {
    if (this.#buffer.length) throw new Error('Truncated native message.');
  }
}
