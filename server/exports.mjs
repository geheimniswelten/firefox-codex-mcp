import { open, unlink, lstat } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';
import { BridgeError } from './bridge-client.mjs';

export const EXPORT_CHUNK_BYTES = 262_144;
export const MAX_EXPORT_BYTES = 128 * 1024 * 1024;
const formats = { save_png: { suffix: '.png', mimeType: 'image/png' }, save_html: { suffix: '.html', mimeType: 'text/html' } };

/** Destinations are supplied by the caller, never by page titles or export metadata. */
export function isValidExportPath(value, method) {
  const format = formats[method];
  if (!format || typeof value !== 'string' || value.length > 32_768 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value) || !isAbsolute(value)) return false;
  const segments = value.split(/[\\/]/);
  if (segments.some(segment => segment === '.' || segment === '..')) return false;
  if (process.platform === 'win32') {
    // Root-relative paths and device namespaces are not fully qualified file destinations.
    if (!/^[a-z]:[\\/]/i.test(value) && !/^\\\\[^\\/]+\\[^\\/]+[\\/]/.test(value)) return false;
    if (/^\\\\[?.]\\/.test(value)) return false;
    const root = win32.parse(value).root;
    if (value.slice(root.length).split(/[\\/]/).some(segment => /[<>:"|?*]/.test(segment) || /[ .]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]*\.|[ .]*$)/i.test(segment))) return false;
  }
  return value.toLowerCase().endsWith(format.suffix);
}

function cancelled(signal) {
  if (signal?.aborted) throw new BridgeError('CANCELLED', 'The export was cancelled; no completed file was saved.');
}

function invalidTransfer(message) {
  throw new BridgeError('INVALID_EXPORT', message);
}

function validateMetadata(metadata, method) {
  const expected = formats[method];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) invalidTransfer('Firefox returned invalid export metadata.');
  if (typeof metadata.transferId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(metadata.transferId)) invalidTransfer('Firefox returned an invalid export transfer ID.');
  if (!Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1 || metadata.byteLength > MAX_EXPORT_BYTES) invalidTransfer('Firefox export must contain from 1 byte to 128 MiB.');
  if (metadata.mimeType !== expected.mimeType) invalidTransfer('Firefox returned an unexpected export format.');
  if (metadata.warnings !== undefined && (!Array.isArray(metadata.warnings) || metadata.warnings.length > 100 || metadata.warnings.some(value => typeof value !== 'string' || value.length > 4096))) invalidTransfer('Firefox returned invalid export warnings.');
}

function decodeChunk(chunk, index, remaining) {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) || chunk.index !== index || typeof chunk.done !== 'boolean') invalidTransfer('Firefox returned an out-of-order or invalid export chunk.');
  if (typeof chunk.data !== 'string' || chunk.data.length > 4 * Math.ceil(EXPORT_CHUNK_BYTES / 3) || chunk.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.data)) invalidTransfer('Firefox returned invalid base64 export data.');
  const data = Buffer.from(chunk.data, 'base64');
  const expectedBytes = Math.min(EXPORT_CHUNK_BYTES, remaining);
  if (data.length !== expectedBytes || data.toString('base64') !== chunk.data) invalidTransfer('Firefox returned an export chunk with an unexpected length or encoding.');
  if (chunk.done !== (data.length === remaining)) invalidTransfer('Firefox ended the export at an unexpected byte count.');
  return data;
}

function fileError(error) {
  if (error instanceof BridgeError) return error;
  if (error?.code === 'EEXIST') return new BridgeError('FILE_EXISTS', 'The destination already exists. Choose a new filename; exports never overwrite existing files.');
  if (error?.code === 'ENOENT') return new BridgeError('OUTPUT_DIRECTORY_MISSING', 'The destination directory does not exist. Create it or choose an existing directory.');
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return new BridgeError('FILE_ACCESS_DENIED', 'The export destination is not writable. Choose another path.');
  return new BridgeError('FILE_WRITE_FAILED', 'The export could not be saved.');
}

async function stillOwnFile(path, identity) {
  try {
    const current = await lstat(path, { bigint: true });
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Download bounded chunks to a new local file. This never repeats an export mutation. */
export async function saveExport(bridge, method, params, { signal } = {}) {
  if (!isValidExportPath(params?.path, method)) throw new BridgeError('INVALID_OUTPUT_PATH', `Provide a fully qualified absolute path ending in ${formats[method]?.suffix || 'the export extension'}, without traversal or device names.`);
  const { path, ...browserParams } = params;
  let file;
  let identity;
  let metadata;
  let transferId;
  let saved = false;
  let released = true;
  let failure;
  try {
    cancelled(signal);
    file = await open(path, 'wx', 0o600);
    identity = await file.stat({ bigint: true });
    cancelled(signal);
    metadata = await bridge.call(method, browserParams, { signal });
    // Preserve a syntactically valid ID for cleanup even if other metadata is malformed.
    if (typeof metadata?.transferId === 'string' && /^[a-z0-9_-]{1,128}$/i.test(metadata.transferId)) transferId = metadata.transferId;
    validateMetadata(metadata, method);
    let written = 0;
    for (let index = 0; written < metadata.byteLength; index++) {
      cancelled(signal);
      const chunk = await bridge.call('export_chunk', { transferId, index }, { signal });
      const data = decodeChunk(chunk, index, metadata.byteLength - written);
      cancelled(signal);
      let offset = 0;
      while (offset < data.length) {
        cancelled(signal);
        const result = await file.write(data, offset, data.length - offset, null);
        if (result.bytesWritten < 1) throw new BridgeError('FILE_WRITE_FAILED', 'The destination stopped accepting export data.');
        offset += result.bytesWritten;
      }
      written += data.length;
    }
    cancelled(signal);
    await file.sync();
    cancelled(signal);
    if (!await stillOwnFile(path, identity)) throw new BridgeError('OUTPUT_CHANGED', 'The destination was removed or replaced during the export. The replacement was not overwritten or removed.');
    await file.close();
    file = null;
    saved = true;
  } catch (error) {
    failure = fileError(error);
  } finally {
    if (file) {
      try { await file.close(); } catch { /* Preserve the original failure. */ }
      try { if (identity && await stillOwnFile(path, identity)) await unlink(path); }
      catch (error) {
        if (error?.code !== 'ENOENT') failure = new BridgeError(failure?.code || 'FILE_WRITE_FAILED', `${failure?.message || 'The export failed.'} The incomplete file could not be removed.`, { path, incompleteFile: true });
      }
    }
    if (transferId) {
      // Do not inherit an aborted caller signal: release must still reach Firefox.
      try { await bridge.call('export_release', { transferId }); }
      catch { released = false; }
    }
  }
  if (failure) throw failure;
  const { transferId: _transferId, ...details } = metadata;
  return { ...details, saved, path, ...(!released ? { warnings: [...(details.warnings || []), 'Temporary export data could not be released immediately; Firefox will expire it automatically.'] } : {}) };
}
