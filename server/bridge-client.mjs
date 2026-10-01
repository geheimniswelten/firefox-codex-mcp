import http from 'node:http';

const MAX_PACKET_BYTES = 900_000;
const MAX_REQUEST_BYTES = 65_536;

export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** A fixed-loopback, bounded native-host client. Mutations are never retried. */
export function createBridgeClient({ port, token }, { timeoutMs = 35_000, contentTimeoutMs = 150_000, exportTimeoutMs = 300_000 } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{64}$/i.test(token ?? '')) {
    throw new BridgeError('INVALID_CONFIG', 'Bridge configuration requires a port from 1024 to 65535 and a 64-character hex token.');
  }
  if (![timeoutMs, contentTimeoutMs].every(value => Number.isInteger(value) && value >= 1 && value <= 180_000)) {
    throw new BridgeError('INVALID_CONFIG', 'Bridge timeouts must be from 1 to 180000 milliseconds.');
  }
  if (!Number.isInteger(exportTimeoutMs) || exportTimeoutMs < 1 || exportTimeoutMs > 600_000) {
    throw new BridgeError('INVALID_CONFIG', 'Export timeout must be from 1 to 600000 milliseconds.');
  }

  return {
    call(method, params = {}, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (typeof method !== 'string' || !/^[a-z_]+$/.test(method) || !params || typeof params !== 'object' || Array.isArray(params)) {
          reject(new BridgeError('INVALID_REQUEST', 'Invalid bridge method or parameters.'));
          return;
        }
        if (signal?.aborted) {
          reject(new BridgeError('CANCELLED', 'The request was cancelled before it reached Firefox.'));
          return;
        }
        let body;
        try {
          body = JSON.stringify({ method, params });
        } catch {
          reject(new BridgeError('INVALID_REQUEST', 'Bridge parameters must be JSON serializable.'));
          return;
        }
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
          reject(new BridgeError('REQUEST_TOO_LARGE', 'Bridge request exceeds 64 KiB; send fewer URLs or shorter values.'));
          return;
        }

        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(value);
        };
        const req = http.request({
          hostname: '127.0.0.1',
          family: 4,
          port,
          path: '/rpc',
          method: 'POST',
          agent: false,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, response => {
          const chunks = [];
          let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_PACKET_BYTES) {
              finish(new BridgeError('RESPONSE_TOO_LARGE', 'Firefox response exceeds the message size limit; request fewer tabs or less content.'));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => finish(new BridgeError('BRIDGE_DISCONNECTED', 'Firefox disconnected during the request. Its outcome may be unknown; inspect the current state before retrying a change.')));
          response.on('end', () => {
            if (settled) return;
            if (response.statusCode === 401 || response.statusCode === 403) {
              finish(new BridgeError('BRIDGE_UNAUTHORIZED', 'Firefox bridge authentication failed. Run setup again and restart the bridge and MCP connection.'));
              return;
            }
            let envelope;
            try {
              envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              finish(new BridgeError('INVALID_RESPONSE', 'The local bridge returned invalid JSON.'));
              return;
            }
            if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
              finish(new BridgeError('INVALID_RESPONSE', 'The local bridge returned an invalid response envelope.'));
              return;
            }
            if (envelope.error && typeof envelope.error.code === 'string' && typeof envelope.error.message === 'string') {
              finish(new BridgeError(envelope.error.code, envelope.error.message, envelope.error.details));
              return;
            }
            if (response.statusCode < 200 || response.statusCode >= 300) {
              finish(new BridgeError('BRIDGE_HTTP_ERROR', `The local Firefox bridge returned HTTP ${response.statusCode}.`));
              return;
            }
            if (!Object.hasOwn(envelope, 'result') || Object.hasOwn(envelope, 'error')) {
              finish(new BridgeError('INVALID_RESPONSE', 'The local bridge response must contain exactly one result or error.'));
              return;
            }
            finish(null, envelope.result);
          });
        });
        const timer = setTimeout(() => {
          finish(new BridgeError('BRIDGE_TIMEOUT', 'Firefox did not respond in time. The action may have completed; inspect the current state before retrying a change.'));
          req.destroy();
        }, method === 'read_content' ? contentTimeoutMs : ['save_png', 'save_html', 'save_pdf'].includes(method) ? exportTimeoutMs : timeoutMs);
        const onAbort = () => {
          finish(new BridgeError('CANCELLED', 'The request was cancelled. Firefox may already have applied the action; inspect the current state before retrying.'));
          req.destroy();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        req.on('error', error => {
          if (error.code === 'ECONNREFUSED') {
            finish(new BridgeError('FIREFOX_OFFLINE', 'Firefox bridge is unavailable; registration does not mean the extension is running. First ask the user whether to wait for reconnection or open about:debugging#/runtime/this-firefox in Firefox to load or reload the Codex Bridge extension. Start Firefox if needed. Follow the user\'s choice, then retry firefox_status after the user finishes checking. Use Computer Use or other browser automation only as a last resort after recovery has failed or the user explicitly chooses that fallback. Do not automatically repeat a mutation whose outcome is unknown.'));
          } else {
            finish(new BridgeError('BRIDGE_DISCONNECTED', 'The local Firefox bridge connection failed. Inspect Firefox state before retrying a change.'));
          }
        });
        req.end(body);
      });
    },
  };
}
