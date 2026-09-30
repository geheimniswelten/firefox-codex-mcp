import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, copyFile, mkdir, writeFile, rm, rmdir, symlink, link, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const windows = process.platform === 'win32';
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
const generated = ['config.json', 'codex-config.toml', 'native-host.cmd', 'de.codex.firefox_bridge.json'];
const psQuote = text => `'${text.replaceAll("'", "''")}'`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'firefox-mcp-uninstall with spaces-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('firefox-mcp-uninstall with spaces-'));
    await rm(root, { recursive: true, force: true });
  });
  await copyFile(join(project, 'uninstall.ps1'), join(root, 'uninstall.ps1'));
  await mkdir(join(root, '.local'));
  await mkdir(join(root, 'server'));
  await mkdir(join(root, 'node_modules'));
  for (const name of generated) await writeFile(join(root, '.local', name), 'FIXTURE_SECRET_MUST_NOT_BE_LOGGED');
  await writeFile(join(root, 'source.txt'), 'preserve source');
  await writeFile(join(root, 'node_modules', 'keep.txt'), 'preserve dependencies');
  return root;
}

const mockBoundaries = `
$script:registration = [pscustomobject]@{ Exists = $true; Manifest = (Join-Path $PSScriptRoot '.local\\de.codex.firefox_bridge.json'); HasChildren = $false }
$script:removals = 0
$script:stopped = @()
$script:processes = @()
function Get-FirefoxBridgeRegistration { return $script:registration }
function Remove-FirefoxBridgeRegistration {
    param([AllowNull()][object]$ExpectedManifest)
    if (-not (Test-FirefoxBridgeRegistrationValue $script:registration.Manifest $ExpectedManifest)) { throw 'Fixture registration snapshot changed.' }
    $script:removals++
    $script:registration = [pscustomobject]@{ Exists = $false; Manifest = $null; HasChildren = $false }
}
function Get-FirefoxBridgeProcesses { return $script:processes }
function Stop-FirefoxBridgeProcess { param($Snapshot); $script:stopped += $Snapshot.ProcessId }
`;

async function runHarness(root, body, { mocks = true } = {}) {
  const harness = join(root, 'test-harness.ps1');
  await writeFile(harness, `$ErrorActionPreference = 'Stop'\n. (Join-Path $PSScriptRoot 'uninstall.ps1')\n${mocks ? mockBoundaries : ''}\n${body}\n`, 'utf8');
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { cwd: root, env: cleanEnv, encoding: 'utf8', timeout: 20_000, windowsHide: true });
}

test('uninstall PowerShell syntax is valid in Windows PowerShell 5.1', { skip: !windows }, () => {
  const script = `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile(${psQuote(join(project, 'uninstall.ps1'))}, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { throw ($errors | Out-String) }; 'Syntax OK'`;
  const result = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: cleanEnv, encoding: 'utf8', windowsHide: true });
  assert.match(result, /Syntax OK/);
});

test('uninstall deletes only owned generated files and registration, preserving source and unknown files', { skip: !windows }, async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.local', 'user-note.txt'), 'preserve this');
  const output = await runHarness(root, `
$script:registration.Manifest = (Join-Path $PSScriptRoot '.local\\..\\.local\\de.codex.firefox_bridge.json').ToUpperInvariant()
$paths = Get-FirefoxBridgeLocalFiles
if (-not (Test-FirefoxBridgePathEqual $paths.Project $PSScriptRoot)) { throw 'Dot-sourced PSScriptRoot is incorrect.' }
Invoke-FirefoxBridgeUninstall
Invoke-FirefoxBridgeUninstall
if ($script:registration.Exists -or $script:removals -ne 1) { throw 'Registry cleanup was not idempotent.' }
if ($script:stopped.Count -ne 0) { throw 'Unexpected process stop.' }
'Fixture cleanup OK'
`);
  assert.match(output, /Fixture cleanup OK/);
  assert.ok(!output.includes('FIXTURE_SECRET_MUST_NOT_BE_LOGGED'));
  for (const name of generated) await assert.rejects(access(join(root, '.local', name)));
  assert.equal(await readFile(join(root, '.local', 'user-note.txt'), 'utf8'), 'preserve this');
  await access(join(root, 'source.txt'));
  await access(join(root, 'node_modules', 'keep.txt'));
});

test('WhatIf leaves everything intact and an empty generated directory is removed on actual fixture cleanup', { skip: !windows }, async t => {
  const root = await fixture(t);
  const output = await runHarness(root, `
Invoke-FirefoxBridgeUninstall -WhatIf
if (-not $script:registration.Exists -or $script:removals -ne 0) { throw 'WhatIf changed registration.' }
foreach ($path in (Get-FirefoxBridgeLocalFiles).Files) { if (-not (Test-Path -LiteralPath $path)) { throw 'WhatIf removed a file.' } }
Invoke-FirefoxBridgeUninstall
Invoke-FirefoxBridgeUninstall
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.local')) { throw 'Empty .local directory remains.' }
if ($script:removals -ne 1) { throw 'Registry cleanup count is wrong.' }
'WhatIf and empty cleanup OK'
`);
  assert.match(output, /WhatIf and empty cleanup OK/);
});

test('a fresh download removes a stale registration even when the original installation directory is missing', { skip: !windows }, async t => {
  const root = await fixture(t);
  const oldRoot = join(root, 'deleted-original-installation');
  const manifest = join(oldRoot, '.local', 'de.codex.firefox_bridge.json');
  const output = await runHarness(root, `
$script:registration.Manifest = ${psQuote(manifest)}
if (Test-Path -LiteralPath ${psQuote(oldRoot)}) { throw 'The old installation must be missing for this test.' }
Invoke-FirefoxBridgeUninstall
if ($script:registration.Exists -or $script:removals -ne 1) { throw 'Stale registration was not removed.' }
if ($script:stopped.Count -ne 0) { throw 'Unexpected process stop.' }
'Missing original installation cleaned'
`);
  assert.match(output, /Missing original installation cleaned/);
  for (const name of generated) await access(join(root, '.local', name));
  await assert.rejects(access(oldRoot));
});

test('a stale registration on an unavailable old drive can be removed from a fresh download', { skip: !windows }, async t => {
  const root = await fixture(t);
  const output = await runHarness(root, `
$drive = @('Z', 'Y', 'X', 'W', 'V', 'U', 'T') | Where-Object { -not (Get-PSDrive -Name $_ -ErrorAction SilentlyContinue) } | Select-Object -First 1
if (-not $drive) { throw 'Fixture requires one unused drive letter.' }
$script:registration.Manifest = $drive + ':\\Unavailable Original\\.local\\de.codex.firefox_bridge.json'
Invoke-FirefoxBridgeUninstall -WhatIf
if (-not $script:registration.Exists -or $script:removals -ne 0) { throw 'WhatIf changed unavailable-drive registration.' }
Invoke-FirefoxBridgeUninstall
if ($script:registration.Exists -or $script:removals -ne 1 -or $script:stopped.Count -ne 0) { throw 'Unavailable-drive registration was not safely removed.' }
'Unavailable-drive registration cleaned'
`);
  assert.match(output, /Unavailable-drive registration cleaned/);
  for (const name of generated) await access(join(root, '.local', name));
});

test('registered old installation anchors WhatIf, file cleanup and process ownership while fresh download files remain intact', { skip: !windows }, async t => {
  const root = await fixture(t);
  const oldRoot = await fixture(t);
  await writeFile(join(oldRoot, '.local', 'keep-user-note.txt'), 'old user note');
  const manifest = join(oldRoot, '.local', 'de.codex.firefox_bridge.json');
  const output = await runHarness(root, `
$oldRoot = ${psQuote(oldRoot)}
$script:registration.Manifest = ${psQuote(manifest)}
$oldScript = Join-Path $oldRoot 'server\\native-host.mjs'
$oldConfig = Join-Path $oldRoot '.local\\config.json'
$newScript = Join-Path $PSScriptRoot 'server\\mcp.mjs'
$newConfig = Join-Path $PSScriptRoot '.local\\config.json'
$script:processes = @(
    [pscustomobject]@{ Name = 'node.exe'; ProcessId = 100001; CommandLine = '"C:\\node.exe" "' + $oldScript + '" --config "' + $oldConfig + '"' },
    [pscustomobject]@{ Name = 'node.exe'; ProcessId = 100002; CommandLine = '"C:\\node.exe" "' + $newScript + '" --config "' + $newConfig + '"' }
)
Invoke-FirefoxBridgeUninstall -WhatIf
if (-not $script:registration.Exists -or $script:removals -ne 0 -or $script:stopped.Count -ne 0) { throw 'Relocated WhatIf mutated state.' }
foreach ($path in (Get-FirefoxBridgeLocalFiles -ProjectPath $oldRoot).Files) { if (-not (Test-Path -LiteralPath $path)) { throw 'Relocated WhatIf removed a file.' } }
Invoke-FirefoxBridgeUninstall
if ($script:registration.Exists -or $script:removals -ne 1) { throw 'Registered old installation was not unregistered.' }
if ($script:stopped.Count -ne 1 -or $script:stopped[0] -ne 100001) { throw 'Process cleanup was not limited to the registered original installation.' }
'Registered old installation cleaned'
`);
  assert.match(output, /Registered old installation cleaned/);
  assert.ok(!output.includes('FIXTURE_SECRET_MUST_NOT_BE_LOGGED'));
  for (const name of generated) {
    await assert.rejects(access(join(oldRoot, '.local', name)));
    await access(join(root, '.local', name));
  }
  assert.equal(await readFile(join(oldRoot, '.local', 'keep-user-note.txt'), 'utf8'), 'old user note');
  await access(join(oldRoot, 'source.txt'));
  await access(join(oldRoot, 'node_modules', 'keep.txt'));
});

test('without a registration, generated files in the current download can be cleaned idempotently', { skip: !windows }, async t => {
  const root = await fixture(t);
  const output = await runHarness(root, `
$script:registration = [pscustomobject]@{ Exists = $false; Manifest = $null; HasChildren = $false }
Invoke-FirefoxBridgeUninstall
Invoke-FirefoxBridgeUninstall
if ($script:removals -ne 0 -or $script:stopped.Count -ne 0) { throw 'Unexpected registry or process change.' }
'Generate-only cleanup complete'
`);
  assert.match(output, /Generate-only cleanup complete/);
  await assert.rejects(access(join(root, '.local')));
  await access(join(root, 'source.txt'));
  await access(join(root, 'node_modules', 'keep.txt'));
});

test('invalid or nonstandard registered paths remove only the fixed application registration', { skip: !windows }, async t => {
  const root = await fixture(t);
  const output = await runHarness(root, `
function Get-FirefoxBridgeProcesses { throw 'Invalid manifest must not trigger process enumeration.' }
$invalidValues = @('relative\\de.codex.firefox_bridge.json', 'C:\\Custom\\custom-host.json', '', $null)
foreach ($value in $invalidValues) {
    $script:registration = [pscustomobject]@{ Exists = $true; Manifest = $value; HasChildren = $false }
    Invoke-FirefoxBridgeUninstall -WhatIf
    if (-not $script:registration.Exists) { throw 'WhatIf removed an invalid registration.' }
    Invoke-FirefoxBridgeUninstall
    if ($script:registration.Exists) { throw 'Invalid application registration was not removed.' }
}
if ($script:removals -ne $invalidValues.Count -or $script:stopped.Count -ne 0) { throw 'Invalid registration cleanup count is wrong.' }
'Invalid registrations cleaned without guessing paths'
`);
  assert.match(output, /Invalid registrations cleaned without guessing paths/);
  for (const name of generated) await access(join(root, '.local', name));
  await access(join(root, 'source.txt'));
});

test('registration removal compares malformed array values structurally and refuses a changed snapshot', { skip: !windows }, async t => {
  const root = await fixture(t);
  const output = await runHarness(root, `
$script:exists = $true
$script:removals = 0
function Get-FirefoxBridgeRegistration {
    return [pscustomobject]@{ Exists = $script:exists; Manifest = $script:value.Clone(); HasChildren = $false }
}
function Remove-Item {
    param([string]$LiteralPath, [switch]$Force)
    if ($LiteralPath -cne 'HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\de.codex.firefox_bridge') { throw 'Unexpected registry deletion target.' }
    $script:removals++
    $script:exists = $false
}
foreach ($kind in @('strings', 'bytes')) {
    $script:exists = $true
    if ($kind -eq 'strings') { $script:value = [string[]]@('malformed first', 'malformed second') }
    else { $script:value = [byte[]]@(1, 2, 3) }
    $snapshot = Get-FirefoxBridgeRegistration
    Remove-FirefoxBridgeRegistration $snapshot.Manifest
    if ($script:exists) { throw 'Unchanged malformed array registration was not removed.' }
}
if ($script:removals -ne 2) { throw 'Unexpected malformed registration removal count.' }
$script:exists = $true
$script:value = [string[]]@('first', 'original')
$snapshot = Get-FirefoxBridgeRegistration
$script:value = [string[]]@('first', 'changed')
$rejected = $false
try { Remove-FirefoxBridgeRegistration $snapshot.Manifest } catch { $rejected = $true }
if (-not $rejected -or -not $script:exists -or $script:removals -ne 2) { throw 'Changed registry snapshot was not preserved.' }
'Malformed arrays and concurrent changes handled safely'
`, { mocks: false });
  assert.match(output, /Malformed arrays and concurrent changes handled safely/);
  for (const name of generated) await access(join(root, '.local', name));
});

test('a .local junction is refused before touching registry or processes', { skip: !windows }, async t => {
  const root = await fixture(t);
  for (const name of generated) await rm(join(root, '.local', name));
  await rmdir(join(root, '.local'));
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'config.json'), 'outside file');
  await symlink(outside, join(root, '.local'), 'junction');
  const output = await runHarness(root, `
$rejected = $false
try { Invoke-FirefoxBridgeUninstall } catch { $rejected = $_.Exception.Message -like '*.local*' }
if (-not $rejected -or $script:removals -ne 0 -or $script:stopped.Count -ne 0) { throw 'Junction was not rejected safely.' }
'Junction rejected'
`);
  assert.match(output, /Junction rejected/);
  assert.equal(await readFile(join(outside, 'config.json'), 'utf8'), 'outside file');
});

test('a hard-linked generated file is refused before any mutation', { skip: !windows }, async t => {
  const root = await fixture(t);
  const outside = join(root, 'outside-config.json');
  await writeFile(outside, 'outside hard link');
  await rm(join(root, '.local', 'config.json'));
  await link(outside, join(root, '.local', 'config.json'));
  const output = await runHarness(root, `
$rejected = $false
try { Invoke-FirefoxBridgeUninstall } catch { $rejected = $_.Exception.Message -like '*Verknuepfung*' }
if (-not $rejected -or $script:removals -ne 0) { throw 'Hard link was not rejected safely.' }
'Hard link rejected'
`);
  assert.match(output, /Hard link rejected/);
  assert.equal(await readFile(outside, 'utf8'), 'outside hard link');
  await access(join(root, '.local', 'codex-config.toml'));
});

test('process ownership requires exact script/config arguments and timestamps compare at CIM microsecond precision', { skip: !windows }, async t => {
  const root = await fixture(t);
  const output = await runHarness(root, `
$paths = Get-FirefoxBridgeLocalFiles
$native = Join-Path $paths.Project 'server\\native-host.mjs'
$mcp = Join-Path $paths.Project 'server\\mcp.mjs'
$prefix = '"C:\\Program Files\\nodejs\\node.exe" '
foreach ($scriptFile in @($native, $mcp)) {
    $snapshot = [pscustomobject]@{ Name = 'node.exe'; CommandLine = $prefix + '"' + $scriptFile + '" --config "' + $paths.Config + '"' }
    if (-not (Test-FirefoxBridgeProcessOwnership $snapshot $paths)) { throw 'Owned command rejected.' }
}
foreach ($command in @(
    ($prefix + '"' + $mcp + '" --config "C:\\foreign\\config.json"'),
    ($prefix + '"C:\\foreign\\mcp.mjs" --config "' + $paths.Config + '"'),
    ($prefix + '"' + $mcp + '" --config "' + $paths.Config + '" extra'),
    ($prefix + '--inspect "' + $mcp + '" --config "' + $paths.Config + '"'),
    ($prefix + 'server\\mcp.mjs --config .local\\config.json')
)) {
    if (Test-FirefoxBridgeProcessOwnership ([pscustomobject]@{ Name = 'node.exe'; CommandLine = $command }) $paths) { throw 'Foreign/ambiguous command accepted.' }
}
$actual = [datetime]::new([long]639263681489607318, [DateTimeKind]::Utc)
$cim = [datetime]::new([long]639263681489607310, [DateTimeKind]::Utc)
if (-not (Test-FirefoxBridgeCreationTime $actual $cim)) { throw 'CIM truncation was not handled.' }
if (Test-FirefoxBridgeCreationTime $actual ([datetime]::new([long]639263681489607320, [DateTimeKind]::Utc))) { throw 'Different creation microsecond accepted.' }
'Ownership and precision OK'
`);
  assert.match(output, /Ownership and precision OK/);
});

test('uninstall can stop only a harmless owned fixture node using its held process handle', { skip: !windows }, async t => {
  const root = await fixture(t);
  const script = join(root, 'server', 'mcp.mjs');
  await writeFile(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script, '--config', join(root, '.local', 'config.json')], { stdio: 'ignore', windowsHide: true });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const output = await runHarness(root, `
$paths = Get-FirefoxBridgeLocalFiles
$snapshot = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${child.pid}'
if (-not (Test-FirefoxBridgeProcessOwnership $snapshot $paths)) { throw 'Fixture child ownership not proved.' }
Stop-FirefoxBridgeProcess $snapshot
'Owned fixture process stopped'
`, { mocks: false });
  assert.match(output, /Owned fixture process stopped/);
  await exited;
  // The helper test stops only its own process; it never invokes live uninstall.
  for (const name of generated) await access(join(root, '.local', name));
});
