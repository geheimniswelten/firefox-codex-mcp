/* Lossless bounded export buffers. These methods are internal to the bridge. */
(() => {
  "use strict";
  const CHUNK_BYTES = 262144, MAX_BYTES = 128 * 1024 * 1024, TTL_MS = 120000;
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  function createTransfers({ now = Date.now, id = () => crypto.randomUUID() } = {}) {
    const records = new Map();
    let total = 0;
    function remove(transferId) { const record = records.get(transferId); if (!record) return false; clearTimeout(record.timer); total -= record.bytes.byteLength; records.delete(transferId); return true; }
    function prune() { for (const [key, record] of records) if (now() >= record.expiresAt) remove(key); }
    return {
      put(bytes, metadata, assertAccess) {
        prune();
        if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) fail("EXPORT_TOO_LARGE", "Export muss zwischen 1 Byte und 128 MiB groß sein.");
        if (records.size >= 4 || total + bytes.byteLength > MAX_BYTES) fail("EXPORT_BUSY", "Zu viele oder zu große Exporte warten auf die Übertragung.");
        const transferId = id();
        const record = { bytes, assertAccess, expiresAt: now() + TTL_MS };
        records.set(transferId, record); total += bytes.byteLength;
        record.timer = setTimeout(() => { if (records.get(transferId) === record) remove(transferId); }, TTL_MS);
        record.timer.unref?.(); // Node tests should not be kept alive by unused buffers.
        return { ...metadata, transferId, byteLength: bytes.byteLength };
      },
      async chunk(transferId, index) {
        prune();
        const record = records.get(transferId);
        if (!record) fail("EXPORT_EXPIRED", "Export ist abgelaufen oder wurde freigegeben. Neu speichern.");
        try { await record.assertAccess?.(); } catch (error) { remove(transferId); throw error; }
        if (records.get(transferId) !== record || now() >= record.expiresAt) { remove(transferId); fail("EXPORT_EXPIRED", "Export ist während der Freigabeprüfung abgelaufen."); }
        const offset = index * CHUNK_BYTES;
        if (!Number.isSafeInteger(index) || index < 0 || offset >= record.bytes.byteLength) fail("INVALID_PARAMS", "Ungültiger Export-Blockindex.");
        const bytes = record.bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, record.bytes.byteLength));
        let binary = "";
        for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        return { index, data: btoa(binary), done: offset + bytes.length === record.bytes.byteLength };
      },
      release(transferId) { return { released: remove(transferId) }; },
      clear() { for (const key of records.keys()) remove(key); },
    };
  }
  globalThis.FirefoxBridgeTransfers = { createTransfers, CHUNK_BYTES, MAX_BYTES, TTL_MS };
})();
