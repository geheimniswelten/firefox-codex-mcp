import { execFile } from 'node:child_process';
import { arch, freemem, totalmem, platform } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DIAGNOSTIC_METHODS = new Set(['get_environment', 'get_processes', 'monitor_resources', 'get_network_state', 'diagnostics_snapshot', 'diagnose_tab']);
const processScript = `$ErrorActionPreference='Stop'; $rows=@(Get-Process -Name firefox -ErrorAction SilentlyContinue | ForEach-Object { try { [pscustomobject]@{pid=$_.Id;startedAt=$_.StartTime.ToUniversalTime().ToString('o');cpuSeconds=$_.TotalProcessorTime.TotalSeconds;workingSetBytes=$_.WorkingSet64;privateBytes=$_.PrivateMemorySize64;threads=$_.Threads.Count;handles=$_.HandleCount} } catch {} }); ConvertTo-Json -InputObject $rows -Compress`;
const socketScript = `$ErrorActionPreference='Stop'; $ids=@(Get-Process -Name firefox -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); $rows=@(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $ids -contains $_.OwningProcess } | Group-Object State | ForEach-Object { [pscustomobject]@{state=[string]$_.Name;count=$_.Count} }); ConvertTo-Json -InputObject $rows -Compress`;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const unavailable = reason => ({ available: false, reason });

export function cpuDelta(before, after) {
  const elapsedSeconds = (Date.parse(after.measuredAt) - Date.parse(before.measuredAt)) / 1000;
  const previous = new Map(before.processes.map(row => [`${row.pid}:${row.startedAt}`, row]));
  return after.processes.map(row => {
    const old = previous.get(`${row.pid}:${row.startedAt}`);
    const change = old ? row.cpuSeconds - old.cpuSeconds : -1;
    return { ...row, cpuPercentOneCore: elapsedSeconds > 0 && change >= 0 ? change / elapsedSeconds * 100 : null,
      privateBytesChange: old ? row.privateBytes - old.privateBytes : null };
  });
}

export function createDiagnostics({ run = execFile, osPlatform = platform(), now = () => new Date().toISOString(), sleep = delay } = {}) {
  let active = 0;
  const systemMemory = () => ({ totalBytes: totalmem(), freeBytes: freemem(), source: 'node:os', scope: 'whole-computer' });
  const query = (script, signal) => new Promise((resolve, reject) => {
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    run(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 512000, encoding: 'utf8', signal }, (error, stdout) => {
      if (error) { reject(error); return; }
      try { const rows = JSON.parse(stdout.replace(/^\uFEFF/u, '')); if (!Array.isArray(rows)) throw new Error(); resolve(rows); }
      catch { reject(new Error('INVALID_DIAGNOSTIC_DATA')); }
    });
  });
  async function processes(signal) {
    if (osPlatform !== 'win32') return unavailable('PROCESS_COLLECTION_NOT_SUPPORTED_ON_THIS_PLATFORM');
    try {
      const rows = await query(processScript, signal);
      if (rows.length > 1000 || rows.some(row => !Number.isInteger(row.pid) || row.pid <= 0 || typeof row.startedAt !== 'string' || !Number.isFinite(Date.parse(row.startedAt)) || !['cpuSeconds', 'workingSetBytes', 'privateBytes', 'threads', 'handles'].every(key => finite(row[key])))) throw new Error();
      return { available: true, measuredAt: now(), source: 'windows:Get-Process', scope: 'all-firefox-processes-across-profiles',
        processes: rows.map(row => Object.fromEntries(['pid', 'startedAt', 'cpuSeconds', 'workingSetBytes', 'privateBytes', 'threads', 'handles'].map(key => [key, row[key]]))),
        tabAttribution: unavailable('NO_SUPPORTED_TAB_TO_PROCESS_MAPPING'),
        limitations: ['Processes may exit or be inaccessible during collection.', 'Working sets can share memory; their sum is not unique physical memory.', 'cpuSeconds is cumulative CPU time, not current CPU utilization.'] };
    } catch { return unavailable(signal?.aborted ? 'CANCELLED' : 'PROCESS_COLLECTION_FAILED_OR_TIMED_OUT'); }
  }
  async function network(signal) {
    if (osPlatform !== 'win32') return unavailable('SOCKET_COLLECTION_NOT_SUPPORTED_ON_THIS_PLATFORM');
    try {
      const rows = await query(socketScript, signal);
      const states = new Set(['Closed','Listen','SynSent','SynReceived','Established','FinWait1','FinWait2','CloseWait','Closing','LastAck','TimeWait','DeleteTCB','Bound']);
      if (rows.length > states.size || rows.some(row => !states.has(row.state) || !Number.isInteger(row.count) || row.count < 0)) throw new Error();
      return { available: true, measuredAt: now(), source: 'windows:Get-NetTCPConnection', scope: 'all-firefox-processes-across-profiles', tcpStates: rows.map(row => ({ state: row.state, count: row.count })), limitations: ['No endpoints or request data.', 'UDP/QUIC, DNS timings, HTTP status and per-tab attribution are unavailable.', 'A connection state alone does not establish the cause of a loading failure.'] };
    } catch { return unavailable(signal?.aborted ? 'CANCELLED' : 'SOCKET_COLLECTION_FAILED_OR_TIMED_OUT'); }
  }
  return async function collect(method, params, browserState, signal) {
    if (!DIAGNOSTIC_METHODS.has(method)) return browserState;
    if (active >= 2) return { ...browserState, nativeDiagnostics: unavailable('DIAGNOSTICS_BUSY') };
    active++;
    try {
      const result = { ...browserState, nativeDiagnostics: { measuredAt: now(), systemMemory: systemMemory() } };
      const data = result.nativeDiagnostics;
      if (method === 'get_environment') {
        Object.assign(data, { platform: osPlatform, architecture: arch(), processMetricsSupported: osPlatform === 'win32', socketMetricsSupported: osPlatform === 'win32' });
      } else if (method === 'get_network_state') data.network = await network(signal);
      else if (method === 'monitor_resources') {
        if (!Number.isInteger(params.durationMs ?? 2000) || (params.durationMs ?? 2000) < 1000 || (params.durationMs ?? 2000) > 10000) throw new Error('Invalid monitor duration.');
        const before = await processes(signal);
        if (before.available) {
          await sleep(params.durationMs ?? 2000, undefined, { signal });
          const after = await processes(signal);
          data.samples = [before, after];
          data.interval = after.available ? { elapsedMs: Date.parse(after.measuredAt) - Date.parse(before.measuredAt), processes: cpuDelta(before, after), cpuSemantics: '100 percent equals one fully busy logical CPU; values may exceed 100.' } : unavailable('SECOND_SAMPLE_UNAVAILABLE');
          data.systemMemoryAfter = systemMemory();
        } else data.samples = [before];
      } else {
        data.resources = await processes(signal);
        if (method === 'diagnostics_snapshot') data.network = await network(signal);
      }
      return result;
    } finally { active--; }
  };
}
