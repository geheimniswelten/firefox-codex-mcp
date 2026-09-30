import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windowsOnly = { skip: process.platform !== 'win32' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "firefox-mcp-install O'Brien "));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('firefox-mcp-install '));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'scripts'));
  await copyFile(join(projectRoot, 'install.ps1'), join(root, 'install.ps1'));
  await copyFile(join(projectRoot, 'scripts', 'node-runtime.ps1'), join(root, 'scripts', 'node-runtime.ps1'));
  // Exercise the actual PowerShell wrapper and Node executable, while replacing
  // only package installation and registration with harmless recording stubs.
  // A Node installation may bundle real npm; never accidentally run that in a
  // wrapper fixture. Runtime discovery itself has separate integration tests.
  await appendFile(join(root, 'scripts', 'node-runtime.ps1'), `
function Find-FirefoxSystemNodeRuntime {
  if (-not (Test-FirefoxNodeVersion -NodePath $env:FIREFOX_MCP_TEST_NODE)) { throw 'Actual test Node version rejected.' }
  return [pscustomobject]@{ NodePath = $env:FIREFOX_MCP_TEST_NODE; NpmCliPath = (Join-Path $PSScriptRoot 'npm-stub.mjs'); NpmCommandPath = $null }
}
`);
  await writeFile(join(root, 'scripts', 'npm-stub.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../npm-args.txt', import.meta.url), process.argv.slice(2).join(' '));
process.exit(Number(process.env.FIREFOX_MCP_TEST_NPM_EXIT));
`);
  await writeFile(join(root, 'scripts', 'setup.mjs'), `
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('../setup-args.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'psmodulepath'].includes(key.toLowerCase())));
  env.PATH = [root, dirname(process.execPath), process.env.PATH ?? process.env.Path].join(delimiter);
  env.FIREFOX_MCP_TEST_NPM_EXIT = '0';
  env.FIREFOX_MCP_TEST_NODE = process.execPath;
  const run = (args = [], overrides = {}) => spawnSync(
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'install.ps1'), '-NoDownload', ...args],
    { env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  return { root, run };
}

test('Windows PowerShell 5.1 installer accepts Node and forwards registration from a spaced path', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal((await readFile(join(root, 'npm-args.txt'), 'utf8')).trim(), 'ci --omit=dev');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'setup-args.json'), 'utf8')), ['--register-native']);
});

test('GenerateOnly forwards explicit port and does not request registration', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  const result = run(['-GenerateOnly', '-Port', '42347']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'setup-args.json'), 'utf8')), ['--port', '42347']);
});

test('installer aborts before setup if dependency installation fails', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  const result = run([], { FIREFOX_MCP_TEST_NPM_EXIT: '17' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /npm ci ist fehlgeschlagen/u);
  await assert.rejects(readFile(join(root, 'setup-args.json')), { code: 'ENOENT' });
});
