import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  await copyFile(join(projectRoot, 'scripts', 'open-firefox-setup.ps1'), join(root, 'scripts', 'open-firefox-setup.ps1'));
  // Exercise the production open-page helper without touching a real browser.
  await appendFile(join(root, 'scripts', 'open-firefox-setup.ps1'), `
function Find-FirefoxExecutable {
  if ($env:FIREFOX_MCP_TEST_BROWSER -eq 'missing') { return $null }
  return 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
}
function Start-Process {
  param($FilePath, $ArgumentList, $WindowStyle, $ErrorAction)
  if ($env:FIREFOX_MCP_TEST_BROWSER -eq 'error') { throw 'Fixture browser launch failed.' }
  $record = @{ executable = $FilePath; arguments = $ArgumentList; windowStyle = $WindowStyle } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $PSScriptRoot '..\\browser-open.json'), $record)
  [IO.File]::AppendAllText((Join-Path $PSScriptRoot '..\\sequence.txt'), "browser\n")
}
`);
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
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(new URL('../npm-args.txt', import.meta.url), process.argv.slice(2).join(' '));
appendFileSync(new URL('../sequence.txt', import.meta.url), 'npm\\n');
process.exit(Number(process.env.FIREFOX_MCP_TEST_NPM_EXIT));
`);
  await writeFile(join(root, 'scripts', 'setup.mjs'), `
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(new URL('../setup-args.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
appendFileSync(new URL('../sequence.txt', import.meta.url), 'setup\\n');
process.exit(Number(process.env.FIREFOX_MCP_TEST_SETUP_EXIT));
`);
  await writeFile(join(root, 'scripts', 'configure-clients.mjs'), `
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(new URL('../client-args.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
appendFileSync(new URL('../sequence.txt', import.meta.url), 'clients\\n');
process.exit(Number(process.env.FIREFOX_MCP_TEST_CLIENT_EXIT));
`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'psmodulepath'].includes(key.toLowerCase())));
  env.PATH = [root, dirname(process.execPath), process.env.PATH ?? process.env.Path].join(delimiter);
  env.FIREFOX_MCP_TEST_NPM_EXIT = '0';
  env.FIREFOX_MCP_TEST_SETUP_EXIT = '0';
  env.FIREFOX_MCP_TEST_CLIENT_EXIT = '0';
  env.FIREFOX_MCP_TEST_NODE = process.execPath;
  env.TEMP = root;
  env.TMP = root;
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
  assert.deepEqual(JSON.parse(await readFile(join(root, 'client-args.json'), 'utf8')), ['--root', await realpath(root)]);
  assert.equal(await readFile(join(root, 'sequence.txt'), 'utf8'), 'npm\nsetup\nclients\nbrowser\n');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'browser-open.json'), 'utf8')), {
    executable: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    arguments: ['-new-tab', 'about:debugging#/runtime/this-firefox'],
    windowStyle: 'Normal',
  });
});

test('GenerateOnly forwards explicit port and does not request registration', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  const result = run(['-GenerateOnly', '-Port', '42347']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'setup-args.json'), 'utf8')), ['--port', '42347']);
  await assert.rejects(readFile(join(root, 'browser-open.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'client-args.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'sequence.txt'), 'utf8'), 'npm\nsetup\n');
});

test('installer aborts before setup if dependency installation fails', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  const result = run([], { FIREFOX_MCP_TEST_NPM_EXIT: '17' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /npm ci ist fehlgeschlagen/u);
  await assert.rejects(readFile(join(root, 'setup-args.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'client-args.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'browser-open.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'sequence.txt'), 'utf8'), 'npm\n');
});

test('native setup failure stops before client registration and Firefox launch', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  const result = run([], { FIREFOX_MCP_TEST_SETUP_EXIT: '23' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout + result.stderr, /Native-Host-Einrichtung ist fehlgeschlagen/u);
  await assert.rejects(readFile(join(root, 'client-args.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'browser-open.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'sequence.txt'), 'utf8'), 'npm\nsetup\n');
});

test('NoRegisterClients skips client changes but still registers native host and opens Firefox', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  const result = run(['-NoRegisterClients']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'setup-args.json'), 'utf8')), ['--register-native']);
  await assert.rejects(readFile(join(root, 'client-args.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'sequence.txt'), 'utf8'), 'npm\nsetup\nbrowser\n');
});

test('client registration failure still opens Firefox then reports partial failure', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  const result = run([], { FIREFOX_MCP_TEST_CLIENT_EXIT: '19' });
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stdout + result.stderr, /mindestens eine KI-Client-Konfiguration/u);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'client-args.json'), 'utf8')), ['--root', await realpath(root)]);
  assert.equal(await readFile(join(root, 'sequence.txt'), 'utf8'), 'npm\nsetup\nclients\nbrowser\n');
});

test('NoOpenFirefox completes installation without launching the browser', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  const result = run(['-NoOpenFirefox']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'setup-args.json'), 'utf8')), ['--register-native']);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'client-args.json'), 'utf8')), ['--root', await realpath(root)]);
  assert.equal(await readFile(join(root, 'sequence.txt'), 'utf8'), 'npm\nsetup\nclients\n');
  await assert.rejects(readFile(join(root, 'browser-open.json')), { code: 'ENOENT' });
});

test('missing Firefox or a launch failure leaves setup successful and shows manual instructions', windowsOnly, async t => {
  const { root, run } = await fixture(t);
  for (const browser of ['missing', 'error']) {
    const result = run([], { FIREFOX_MCP_TEST_BROWSER: browser });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /about:debugging#\/runtime\/this-firefox/u);
    // PowerShell expands short Windows paths such as FSEMML~1 to their long form.
    const manifestPath = join(await realpath(root), 'extension', 'manifest.json');
    assert.ok(result.stdout.toLowerCase().includes(manifestPath.toLowerCase()), result.stdout);
    await assert.rejects(readFile(join(root, 'browser-open.json')), { code: 'ENOENT' });
  }
});
