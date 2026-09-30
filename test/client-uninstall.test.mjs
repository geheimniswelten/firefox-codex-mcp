import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = { skip: process.platform !== 'win32' };
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const generated = ['config.json', 'codex-config.toml', 'native-host.cmd', 'de.codex.firefox_bridge.json'];
const psQuote = text => `'${text.replaceAll("'", "''")}'`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "firefox-mcp-client-uninstall O'Brien "));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('firefox-mcp-client-uninstall '));
    await rm(root, { recursive: true, force: true });
  });
  const current = join(root, 'fresh download');
  const old = join(root, 'registered installation');
  for (const directory of [current, old]) {
    await mkdir(join(directory, '.local'), { recursive: true });
    for (const name of generated) await writeFile(join(directory, '.local', name), 'FIXTURE_ONLY_SECRET');
  }
  await copyFile(join(project, 'uninstall.ps1'), join(current, 'uninstall.ps1'));
  const log = join(root, 'operations.jsonl');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  Object.assign(env, { TEMP: root, TMP: root, FIREFOX_MCP_TEST_NODE: process.execPath, FIREFOX_MCP_TEST_CLIENT_EXIT: '0', FIREFOX_MCP_TEST_OPERATION_LOG: log });
  async function run(body, overrides = {}) {
    const harness = join(current, 'harness.ps1');
    await writeFile(harness, `
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'uninstall.ps1')
$script:oldRoot = ${psQuote(old)}
$script:registration = [pscustomobject]@{ Exists = $true; Manifest = (Join-Path $script:oldRoot '.local\\de.codex.firefox_bridge.json'); HasChildren = $false }
$script:removals = 0
function Get-FirefoxBridgeRegistration { return $script:registration }
function Remove-FirefoxBridgeRegistration {
    param($ExpectedManifest)
    if (-not (Test-FirefoxBridgeRegistrationValue $ExpectedManifest $script:registration.Manifest)) { throw 'Unexpected registration snapshot.' }
    $script:removals++
    $script:registration = [pscustomobject]@{ Exists = $false; Manifest = $null; HasChildren = $false }
    [IO.File]::AppendAllText($env:FIREFOX_MCP_TEST_OPERATION_LOG, '{"event":"unregister"}' + [Environment]::NewLine)
}
function Get-FirefoxBridgeProcesses { return @() }
function Stop-FirefoxBridgeProcess { throw 'No fixture process may be stopped.' }
function Get-Command {
    param($Name, $CommandType, $ErrorAction)
    if ($Name -ne 'node.exe') { throw 'Unexpected command discovery.' }
    if ($env:FIREFOX_MCP_TEST_NO_SYSTEM_NODE -eq '1') { return $null }
    return [pscustomobject]@{ Source = $env:FIREFOX_MCP_TEST_NODE }
}
${body}
`, 'utf8');
    return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
      cwd: current, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
  }
  const records = async () => (await readFile(log, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  return { root, current, old, run, records };
}

async function registrar(directory, { dependencies = true } = {}) {
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await writeFile(join(directory, 'scripts', 'configure-clients.mjs'), `
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
appendFileSync(process.env.FIREFOX_MCP_TEST_OPERATION_LOG, JSON.stringify({event:'clients',script:fileURLToPath(import.meta.url),node:process.execPath,args:process.argv.slice(2)}) + '\\n');
process.exit(Number(process.env.FIREFOX_MCP_TEST_CLIENT_EXIT));
`);
  if (dependencies) {
    for (const name of ['acorn', 'js-yaml']) {
      await mkdir(join(directory, 'node_modules', name), { recursive: true });
      await writeFile(join(directory, 'node_modules', name, 'package.json'), '{}');
    }
  }
}

test('uninstall prefers current registrar with old runtime and passes registered root including preview', windows, async t => {
  const { current, old, run, records } = await fixture(t);
  await registrar(current);
  await registrar(old);
  await mkdir(join(old, '.runtime', 'node'), { recursive: true });
  await copyFile(process.execPath, join(old, '.runtime', 'node', 'node.exe'));
  const output = await run(`
Invoke-FirefoxBridgeUninstall -WhatIf
if ($script:removals -ne 0 -or -not $script:registration.Exists) { throw 'Preview changed registration.' }
foreach ($file in (Get-FirefoxBridgeLocalFiles -ProjectPath $script:oldRoot).Files) {
    if (-not (Test-Path -LiteralPath $file)) { throw 'Preview removed old local file.' }
}
Invoke-FirefoxBridgeUninstall
if ($script:removals -ne 1 -or $script:registration.Exists) { throw 'Registered installation was not removed.' }
`, { FIREFOX_MCP_TEST_NO_SYSTEM_NODE: '1' });
  assert.ok(!output.includes('FIXTURE_ONLY_SECRET'));
  const oldRoot = await realpath(old);
  const currentRoot = await realpath(current);
  assert.deepEqual(await records(), [
    { event: 'clients', script: join(currentRoot, 'scripts', 'configure-clients.mjs'), node: join(oldRoot, '.runtime', 'node', 'node.exe'), args: ['--remove', '--root', oldRoot, '--dry-run'] },
    { event: 'unregister' },
    { event: 'clients', script: join(currentRoot, 'scripts', 'configure-clients.mjs'), node: join(oldRoot, '.runtime', 'node', 'node.exe'), args: ['--remove', '--root', oldRoot] },
  ]);
  for (const name of generated) {
    await assert.rejects(access(join(old, '.local', name)), { code: 'ENOENT' });
    await access(join(current, '.local', name));
  }
});

test('uninstall falls back to old registrar and client failure does not block native cleanup', windows, async t => {
  const { current, old, run, records } = await fixture(t);
  await registrar(current, { dependencies: false });
  await registrar(old);
  const output = await run(`
Invoke-FirefoxBridgeUninstall
if ($script:removals -ne 1 -or $script:registration.Exists) { throw 'Client failure blocked native removal.' }
`, { FIREFOX_MCP_TEST_CLIENT_EXIT: '17' });
  assert.match(output, /Mindestens ein KI-Client-Eintrag bleibt erhalten/u);
  const oldRoot = await realpath(old);
  assert.deepEqual(await records(), [
    { event: 'unregister' },
    { event: 'clients', script: join(oldRoot, 'scripts', 'configure-clients.mjs'), node: await realpath(process.execPath), args: ['--remove', '--root', oldRoot] },
  ]);
  for (const name of generated) {
    await assert.rejects(access(join(old, '.local', name)), { code: 'ENOENT' });
    await access(join(current, '.local', name));
  }
});

test('missing Node or parser dependencies never block native uninstall from a fresh download', windows, async t => {
  for (const missing of ['node', 'parsers']) {
    await t.test(missing, async subtest => {
      const { current, old, run, records } = await fixture(subtest);
      await registrar(current, { dependencies: missing !== 'parsers' });
      const output = await run(`
Invoke-FirefoxBridgeUninstall
if ($script:removals -ne 1 -or $script:registration.Exists) { throw 'Missing optional client prerequisites blocked native removal.' }
`, { FIREFOX_MCP_TEST_NO_SYSTEM_NODE: missing === 'node' ? '1' : '0' });
      assert.match(output, /Node 22\+ oder die Parserpakete fehlen/u);
      assert.deepEqual(await records(), [{ event: 'unregister' }]);
      for (const name of generated) {
        await assert.rejects(access(join(old, '.local', name)), { code: 'ENOENT' });
        await access(join(current, '.local', name));
      }
    });
  }
});

test('unexpected client discovery failure preserves preview and cannot interrupt native cleanup', windows, async t => {
  const { current, old, run, records } = await fixture(t);
  const output = await run(`
function Remove-FirefoxBridgeClientRegistrations {
    param($ProjectPath, [switch]$Preview)
    if (-not (Test-FirefoxBridgePathEqual $ProjectPath $script:oldRoot)) { throw 'Wrong client root.' }
    throw 'Fixture discovery access denied.'
}
Invoke-FirefoxBridgeUninstall -WhatIf
if ($script:removals -ne 0 -or -not $script:registration.Exists) { throw 'Failed preview changed registration.' }
foreach ($file in (Get-FirefoxBridgeLocalFiles -ProjectPath $script:oldRoot).Files) {
    if (-not (Test-Path -LiteralPath $file)) { throw 'Failed preview removed a local file.' }
}
Invoke-FirefoxBridgeUninstall
if ($script:removals -ne 1 -or $script:registration.Exists) { throw 'Client discovery exception blocked native cleanup.' }
`);
  assert.match(output, /optionale KI-Client-Bereinigung ist nicht verfuegbar/u);
  assert.deepEqual(await records(), [{ event: 'unregister' }]);
  for (const name of generated) {
    await assert.rejects(access(join(old, '.local', name)), { code: 'ENOENT' });
    await access(join(current, '.local', name));
  }
});
