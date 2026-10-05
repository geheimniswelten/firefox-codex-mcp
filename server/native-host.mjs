import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { configPathFromArgs, loadConfig } from './config.mjs';
import { encodeNativeMessage, NativeDecoder } from './framing.mjs';
import { readRegistrationStatus } from '../scripts/registration.mjs';

export const HOST_VERSION = '1.0.5';
export const PROTOCOL_VERSION = 1;

const METHODS = new Set(['status','get_current','list_windows','list_extensions','list_tabs','search_history','list_bookmark_folders','search_bookmarks','create_bookmark','update_bookmark','move_bookmark','delete_bookmark','get_tabs','create_tab','update_tab','set_muted','close_tabs','move_tabs','discard_tabs','reload_tabs','create_window','update_window','close_window','list_groups','group_tabs','ungroup_tabs','update_group','move_group','read_content','wait_for','save_png','save_html','save_pdf','export_chunk','export_release']);
const error = (code, message) => ({ error: { code, message } });
const waitTimeoutMs = params => Number.isInteger(params.timeoutMs) && params.timeoutMs >= 1 && params.timeoutMs <= 120_000 ? params.timeoutMs : 10_000;

function reply(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

// This HTTP endpoint is a private IPC bridge, not a network MCP endpoint.
export function createBridge({ port, token, registration = null, input = process.stdin, output = process.stdout, timeoutMs = 30_000, contentTimeoutMs = 130_000, exportTimeoutMs = 280_000 }) {
  if (!Number.isInteger(exportTimeoutMs) || exportTimeoutMs < 1 || exportTimeoutMs > 600_000) throw new Error('Export timeout must be from 1 to 600000 milliseconds.');
  const pending = new Map();
  let ready = false;
  let closed = false;
  let listeningPort = port;
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const send = message => output.write(encodeNativeMessage(message));
  const cancelWait = (id, method) => {
    if (!['wait_for', 'search_history'].includes(method) || closed || !ready) return;
    try { send({ type: 'cancel', id }); } catch { /* Caller cleanup does not depend on native output. */ }
  };
  const cancelAll = () => {
    for (const { timer, response } of pending.values()) {
      clearTimeout(timer);
      reply(response, 503, error('FIREFOX_DISCONNECTED', 'Firefox disconnected. A mutation may already have run; inspect browser state before retrying.'));
    }
    pending.clear();
  };
  const decoder = new NativeDecoder(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid native response.');
    if (message.type === 'ready') { ready = true; return; }
    if (typeof message.id !== 'string') return;
    const request = pending.get(message.id);
    if (!request) return; // Late or cancelled responses are never replayed.
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error && typeof message.error.message === 'string') {
      reply(request.response, 200, { error: message.error });
    } else if (Object.hasOwn(message, 'result')) {
      reply(request.response, 200, { result: message.result });
    } else {
      reply(request.response, 502, error('INVALID_RESPONSE', 'Firefox returned an invalid response.'));
    }
  });
  const server = http.createServer(async (request, response) => {
    // Browser-origin traffic must never access this endpoint, even with a token.
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
      reply(response, 403, error('ORIGIN_FORBIDDEN', 'Browser-origin requests are not allowed.')); return;
    }
    if (request.headers.host !== `127.0.0.1:${listeningPort}`) {
      reply(response, 403, error('HOST_FORBIDDEN', 'Invalid Host header.')); return;
    }
    const auth = Buffer.from(request.headers.authorization || '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      reply(response, 401, error('UNAUTHORIZED', 'Bridge authentication failed.')); return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      reply(response, 200, { result: { connected: ready, version: HOST_VERSION } }); return;
    }
    if (request.method !== 'POST' || request.url !== '/rpc') {
      reply(response, 404, error('NOT_FOUND', 'Unknown bridge endpoint.')); return;
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      reply(response, 415, error('JSON_REQUIRED', 'Expected application/json.')); return;
    }
    if (!ready || closed) { reply(response, 503, error('FIREFOX_NOT_READY', 'Firefox extension has not connected yet.')); return; }
    if (pending.size >= 64) { reply(response, 429, error('BUSY', 'Too many pending requests.')); return; }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65_536) { reply(response, 413, error('TOO_LARGE', 'Bridge request exceeds 64 KiB.')); return; }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || !METHODS.has(body.method) || !body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
        reply(response, 400, error('INVALID_REQUEST', 'Unknown method or invalid params.')); return;
      }
      if (Object.keys(body).some(key => !['method', 'params'].includes(key))) {
        reply(response, 400, error('INVALID_REQUEST', 'Unexpected request property.')); return;
      }
      if (closed || !ready) { reply(response, 503, error('FIREFOX_DISCONNECTED', 'Firefox disconnected.')); return; }
      // Body streams can finish concurrently after passing the early limit check.
      // Never dispatch a request whose caller has already gone away.
      if (response.destroyed || request.aborted) return;
      if (pending.size >= 64) { reply(response, 429, error('BUSY', 'Too many pending requests.')); return; }
      const id = randomUUID();
      const requestTimeout = body.method === 'wait_for' ? waitTimeoutMs(body.params) + 5_000 : body.method === 'read_content' ? contentTimeoutMs : ['save_png', 'save_html', 'save_pdf'].includes(body.method) ? exportTimeoutMs : timeoutMs;
      const timer = setTimeout(() => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        cancelWait(id, entry.method);
        reply(response, 504, error('TIMEOUT', 'Firefox did not respond in time. A mutation may already have run; inspect browser state before retrying.'));
      }, requestTimeout);
      pending.set(id, { response, timer, method: body.method });
      response.on('close', () => {
        const entry = pending.get(id);
        if (entry) {
          clearTimeout(entry.timer); pending.delete(id);
          cancelWait(id, entry.method);
        }
      });
      try { send({ id, method: body.method, params: body.params, expiresAt: Date.now() + requestTimeout }); }
      catch {
        clearTimeout(timer); pending.delete(id);
        reply(response, 503, error('SEND_FAILED', 'Could not send command to Firefox.'));
      }
    } catch {
      reply(response, 400, error('INVALID_JSON', 'Invalid JSON request.'));
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  const close = () => {
    if (closed) return;
    closed = true; ready = false;
    cancelAll();
    server.close();
    server.closeAllConnections();
    input.removeListener('data', onData);
    input.pause();
  };
  const onData = chunk => {
    try { decoder.push(chunk); }
    catch { console.error('Invalid Firefox native packet; closing bridge.'); close(); }
  };
  input.on('data', onData);
  input.once('end', close);
  input.once('error', close);
  output.once('error', close);
  return {
    server, close,
    async listen() {
      if (closed) throw new Error('Firefox disconnected before bridge startup.');
      // Report setup separately from the HTTP bridge. A occupied port must not
      // hide a confirmed companion installation or appear as missing setup.
      send({ type: 'setup_status', hostVersion: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, registration });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      if (closed) { server.close(); throw new Error('Firefox disconnected during bridge startup.'); }
      listeningPort = server.address().port;
      send({ type: 'connected' });
      return listeningPort;
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const configPath = configPathFromArgs();
    const bridge = createBridge({ ...await loadConfig(configPath), registration: await readRegistrationStatus(configPath) });
    process.once('SIGINT', () => { bridge.close(); process.exit(0); });
    process.once('SIGTERM', () => { bridge.close(); process.exit(0); });
    try { await bridge.listen(); }
    catch (err) {
      bridge.close();
      console.error(err.code === 'EADDRINUSE' ? 'Bridge port is occupied. Enable this extension in only one Firefox profile, or select another installation port.' : 'Native host failed to start.');
      process.exitCode = 1;
    }
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
