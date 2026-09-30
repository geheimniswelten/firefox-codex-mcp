import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const windows = process.platform === 'win32';
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "firefox-node-runtime O'Brien "));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('firefox-node-runtime '));
    await rm(root, { recursive: true, force: true });
  });
  await copyFile(join(project, 'scripts', 'node-runtime.ps1'), join(root, 'node-runtime.ps1'));
  await mkdir(join(root, '.local'));
  await writeFile(join(root, '.local', 'config.json'), 'existing-local-config');
  await writeFile(join(root, 'source.txt'), 'source-must-survive');
  return root;
}

async function run(root, code) {
  const harness = join(root, 'harness.ps1');
  await writeFile(harness, `$ErrorActionPreference='Stop'\n. (Join-Path $PSScriptRoot 'node-runtime.ps1')\n${code}\n`, 'ascii');
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { cwd: root, env: cleanEnv, encoding: 'utf8', timeout: 20000, windowsHide: true });
}

const forbidNetwork = `
function Invoke-FirefoxNodeDownload { throw 'NETWORK_MUST_NOT_RUN' }
function Test-FirefoxNodeVersion { param([string]$NodePath); return [IO.File]::Exists($NodePath) }
`;

test('complete local runtime wins without global Node, PATH changes or downloads', { skip: !windows }, async t => {
  const root = await fixture(t);
  const cli = join(root, '.runtime', 'node', 'node_modules', 'npm', 'bin');
  await mkdir(cli, { recursive: true });
  await writeFile(join(root, '.runtime', 'node', 'node.exe'), 'test-probe-stub');
  await writeFile(join(cli, 'npm-cli.js'), 'test-cli-stub');
  const output = await run(root, `${forbidNetwork}
function Find-FirefoxSystemNodeRuntime { throw 'SYSTEM_SEARCH_MUST_NOT_RUN' }
$beforePath = $env:Path
$result = Resolve-FirefoxNodeRuntime -ProjectRoot $PSScriptRoot
if ($env:Path -cne $beforePath) { throw 'Resolver changed process PATH.' }
if (-not $result.NodePath.EndsWith('.runtime\\node\\node.exe') -or -not $result.NpmCliPath.EndsWith('node_modules\\npm\\bin\\npm-cli.js') -or $result.NpmCommandPath) { throw 'Wrong runtime result.' }
'LOCAL_OK'
`);
  assert.match(output, /LOCAL_OK/);
});

test('missing Node downloads only official version-pinned ZIP, verifies SHA256, stages bundled npm and reuses it', { skip: !windows }, async t => {
  const root = await fixture(t);
  const output = await run(root, `
function Find-FirefoxSystemNodeRuntime { return $null }
function Test-FirefoxNodeVersion { param([string]$NodePath); return [IO.File]::Exists($NodePath) }
function Get-FirefoxNodeArchitecture { return 'x64' }
$script:downloads = @()
function Invoke-FirefoxNodeDownload {
  param([string]$Uri, [string]$OutFile)
  $script:downloads += $Uri
  if (-not $OutFile) {
    return ('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  node-v24.21.0-win-x64.zip' + "\r\n")
  }
  [IO.File]::WriteAllBytes($OutFile, [byte[]]@())
}
function Expand-FirefoxNodeArchive {
  param([string]$ArchivePath, [string]$DestinationPath)
  $package = [IO.Path]::Combine($DestinationPath, 'node-v24.21.0-win-x64')
  $cli = [IO.Path]::Combine($package, 'node_modules\\npm\\bin')
  $null = [IO.Directory]::CreateDirectory($cli)
  [IO.File]::WriteAllText([IO.Path]::Combine($package, 'node.exe'), 'fake runtime')
  [IO.File]::WriteAllText([IO.Path]::Combine($cli, 'npm-cli.js'), 'fake npm')
}
$result = Resolve-FirefoxNodeRuntime -ProjectRoot $PSScriptRoot
if ($script:downloads.Count -ne 2 -or $script:downloads[0] -cne 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' -or $script:downloads[1] -cne 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip') { throw 'Download URL mismatch.' }
if (-not [IO.File]::Exists($result.NodePath) -or -not [IO.File]::Exists($result.NpmCliPath)) { throw 'Incomplete installation.' }
$again = Resolve-FirefoxNodeRuntime -ProjectRoot $PSScriptRoot
if ($script:downloads.Count -ne 2 -or $again.NodePath -cne $result.NodePath) { throw 'Downloaded twice.' }
if (@(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.runtime') -Filter 'download-*').Count -ne 0) { throw 'Stage was not cleaned.' }
'DOWNLOAD_OK'
`);
  assert.match(output, /DOWNLOAD_OK/);
  assert.equal(await readFile(join(root, '.local', 'config.json'), 'utf8'), 'existing-local-config');
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'source-must-survive');
});

test('checksum mismatch never extracts or executes downloaded content and preserves existing project data', { skip: !windows }, async t => {
  const root = await fixture(t);
  const output = await run(root, `
function Find-FirefoxSystemNodeRuntime { return $null }
function Test-FirefoxNodeVersion { throw 'PROBE_MUST_NOT_RUN' }
function Get-FirefoxNodeArchitecture { return 'arm64' }
function Invoke-FirefoxNodeDownload {
  param([string]$Uri, [string]$OutFile)
  if (-not $OutFile) { return ('0' * 64 + '  node-v24.21.0-win-arm64.zip') }
  [IO.File]::WriteAllText($OutFile, 'corrupt zip')
}
function Expand-FirefoxNodeArchive { throw 'EXTRACT_MUST_NOT_RUN' }
try { Resolve-FirefoxNodeRuntime -ProjectRoot $PSScriptRoot; throw 'EXPECTED_FAILURE' }
catch { if ($_.Exception.Message -notmatch 'SHA256') { throw } }
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.runtime\\node')) { throw 'Invalid runtime installed.' }
if (@(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.runtime')).Count -ne 0) { throw 'Corrupt stage remains.' }
'HASH_FAILURE_OK'
`);
  assert.match(output, /HASH_FAILURE_OK/);
  assert.equal(await readFile(join(root, '.local', 'config.json'), 'utf8'), 'existing-local-config');
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'source-must-survive');
});

test('NoDownload gives actionable error, and an unknown partial runtime is never overwritten', { skip: !windows }, async t => {
  const root = await fixture(t);
  const output = await run(root, `${forbidNetwork}
function Find-FirefoxSystemNodeRuntime { return $null }
try { Resolve-FirefoxNodeRuntime -ProjectRoot $PSScriptRoot -NoDownload; throw 'EXPECTED_FAILURE' }
catch { if ($_.Exception.Message -notmatch 'Node.js 22.*install.cmd') { throw } }
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.runtime')) { throw 'NoDownload created a directory.' }
$nodeDirectory = Join-Path $PSScriptRoot '.runtime\\node'
$null = [IO.Directory]::CreateDirectory($nodeDirectory)
[IO.File]::WriteAllText([IO.Path]::Combine($nodeDirectory, 'user-file.txt'), 'preserve-me')
try { Resolve-FirefoxNodeRuntime -ProjectRoot $PSScriptRoot; throw 'EXPECTED_FAILURE' }
catch { if ($_.Exception.Message -notmatch 'incomplete or too old.*preserved') { throw } }
if ([IO.File]::ReadAllText([IO.Path]::Combine($nodeDirectory, 'user-file.txt')) -cne 'preserve-me') { throw 'Unknown runtime content lost.' }
'PRESERVE_OK'
`);
  assert.match(output, /PRESERVE_OK/);
});
