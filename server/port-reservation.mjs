import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('../scripts/windows-port-reservation.ps1', import.meta.url));
const actions = new Set(['status', 'init', 'check', 'prepare', 'suggest', 'reserve', 'release']);

/** The Windows helper holds the shared global mutex across the whole operation. */
export async function managePortReservation(action, { port = 38477, directory, platform = process.platform, run = execute } = {}) {
  if (!actions.has(action)) throw new Error('Unknown port reservation action.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535.');
  if (directory !== undefined && (!isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory))) throw new Error('An absolute port directory is required.');
  if (!['win', 'win32'].includes(platform)) {
    if (['init', 'reserve', 'release'].includes(action)) throw new Error('Shared port management currently supports Windows only.');
    return { supported: false, exists: false, changed: false, ownPorts: [], port };
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  // Resolve Windows PowerShell from SystemRoot, rather than an executable on PATH.
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const request = Buffer.from(JSON.stringify({ action, port, ...(directory === undefined ? {} : { directory }) })).toString('base64');
  let output;
  try {
    output = await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Request', request], {
      env, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024, cwd: dirname(helper),
    });
  } catch (error) {
    // The helper returns structured errors even for failed transactions. Avoid
    // including process environment or unrelated command output in diagnostics.
    output = { stdout: error.stdout || '' };
  }
  let result;
  try { result = JSON.parse(output.stdout.replace(/^\uFEFF/u, '').trim()); }
  catch { throw Object.assign(new Error('Windows port management could not be executed. Check Windows PowerShell and shared-directory permissions.'), { code: 'PORT_RESERVATION_FAILED' }); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Windows port management response.');
  if (result.error) throw Object.assign(new Error(String(result.error.message)), { code: String(result.error.code) });
  if (result.supported !== true || typeof result.exists !== 'boolean' || !Array.isArray(result.ownPorts) || !result.ownPorts.every(value => Number.isInteger(value) && value >= 1 && value <= 65535)) throw new Error('Invalid Windows port management response.');
  return result;
}
