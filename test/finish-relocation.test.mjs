import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = { skip: process.platform !== 'win32' };
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const quote = value => `'${value.replaceAll("'", "''")}'`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "firefox-mcp-finish O'Brien "));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('firefox-mcp-finish '));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'scripts'));
  await copyFile(join(project, 'uninstall.ps1'), join(root, 'uninstall.ps1'));
  await copyFile(join(project, 'scripts', 'finish-relocation.ps1'), join(root, 'scripts', 'finish-relocation.ps1'));
  const old = join(root, 'old installation'), current = join(root, 'current installation');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  Object.assign(env, { TEMP: root, TMP: root });
  const run = async body => {
    const harness = join(root, 'harness.ps1');
    await writeFile(harness, `
$ErrorActionPreference = 'Stop'
$script:oldRoot = ${quote(old)}
$script:currentRoot = ${quote(current)}
$script:oldManifest = [IO.Path]::Combine($script:oldRoot, '.local\\de.codex.firefox_bridge.json')
$script:newManifest = [IO.Path]::Combine($script:currentRoot, '.local\\de.codex.firefox_bridge.json')
$script:key = [pscustomobject]@{ Value = $script:newManifest; SubKeyCount = 0; ValueNames = @(''); Closed = 0 }
$script:key | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($Name, $Fallback, $Options) return $this.Value }
$script:key | Add-Member -MemberType ScriptMethod -Name GetValueNames -Value { return $this.ValueNames }
$script:key | Add-Member -MemberType ScriptMethod -Name Close -Value { $this.Closed++ }
$script:reads = 0
$script:processes = @()
$script:stopped = @()
function Get-Item {
    param($LiteralPath, $ErrorAction)
    if ($LiteralPath -cne 'HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\de.codex.firefox_bridge') { throw 'Unexpected registry access.' }
    $script:reads++
    if ($script:absent) { return $null }
    return $script:key
}
function Get-CimInstance { throw 'Real process enumeration is forbidden.' }
function Remove-Item { throw 'Registry or filesystem deletion is forbidden.' }
. (Join-Path $PSScriptRoot 'scripts\\finish-relocation.ps1')
if ($script:reads -ne 0) { throw 'Dot-sourcing touched the registry.' }
function Get-FirefoxBridgeLocalFiles {
    param($ProjectPath)
    if (-not (Test-FirefoxBridgePathEqual $ProjectPath $script:oldRoot)) { throw 'Incorrect old root.' }
    return [pscustomobject]@{ Project = $ProjectPath; Config = [IO.Path]::Combine($ProjectPath, '.local\\config.json') }
}
function Get-FirefoxBridgeProcesses { return $script:processes }
function Get-FirefoxBridgeProcessArguments { param($CommandLine) $parsed = $CommandLine | ConvertFrom-Json; return $parsed }
function Stop-FirefoxBridgeProcess {
    param($Snapshot)
    if ($Snapshot.ProcessId -notin @(101,102)) { throw 'A foreign fixture process would be stopped.' }
    $script:stopped += [int]$Snapshot.ProcessId
}
function New-FixtureProcess {
    param($Id, $Root, $Script = 'mcp.mjs', $Extra)
    $arguments = @('C:\\fixture-node.exe', [IO.Path]::Combine($Root, 'server', $Script), '--config', [IO.Path]::Combine($Root, '.local\\config.json'))
    if ($Extra) { $arguments += $Extra }
    return [pscustomobject]@{ Name = 'node.exe'; ProcessId = $Id; CommandLine = (ConvertTo-Json -InputObject $arguments -Compress); CreationDate = [datetime]'2026-10-05T10:00:00Z' }
}
${body}
`, 'utf8');
    return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  };
  return { run };
}

test('relocation finish reads only a valid fixed registration and closes every registry snapshot', windows, async t => {
  const { run } = await fixture(t);
  await run(`
if (-not (Test-FirefoxBridgePathEqual (Get-FirefoxPreviousManifest) $script:newManifest)) { throw 'Wrong snapshot.' }
if ($script:key.Closed -ne 1) { throw 'Registry handle was not closed.' }
$script:absent = $true
if ($null -ne (Get-FirefoxPreviousManifest)) { throw 'Absent registration was invented.' }
$script:absent = $false
foreach ($kind in @('children','values','relative','foreign','control')) {
    $script:key.SubKeyCount = if ($kind -eq 'children') { 1 } else { 0 }
    $script:key.ValueNames = if ($kind -eq 'values') { @('', 'unknown') } else { @('') }
    $script:key.Value = if ($kind -eq 'relative') { '.local\\de.codex.firefox_bridge.json' } elseif ($kind -eq 'foreign') { 'C:\\foreign.json' } elseif ($kind -eq 'control') { $script:newManifest + [char]10 } else { $script:newManifest }
    $rejected = $false
    try { $null = Get-FirefoxPreviousManifest } catch { $rejected = $true }
    if (-not $rejected) { throw "Unsafe snapshot accepted: $kind" }
}
if ($script:key.Closed -ne 6 -or $script:stopped.Count -ne 0) { throw 'Incorrect read-only boundary.' }
`);
});

test('relocation finish stops only exact old native/MCP processes after the new registration is confirmed', windows, async t => {
  const { run } = await fixture(t);
  const output = await run(`
$script:processes = @((New-FixtureProcess 101 $script:oldRoot), (New-FixtureProcess 102 $script:oldRoot 'native-host.mjs'), (New-FixtureProcess 201 $script:currentRoot), (New-FixtureProcess 202 'C:\\foreign-installation'))
Stop-FirefoxPreviousInstallation -PreviousManifest $script:oldManifest -CurrentRoot $script:currentRoot
if (($script:stopped -join ',') -cne '101,102') { throw 'Old processes were not selected exactly.' }
if ($script:reads -ne 3) { throw 'Registration was not checked before each stop.' }
$script:stopped = @()
Stop-FirefoxPreviousInstallation -PreviousManifest $script:newManifest -CurrentRoot $script:currentRoot
Stop-FirefoxPreviousInstallation -PreviousManifest $null -CurrentRoot $script:currentRoot
if ($script:stopped.Count -ne 0 -or $script:reads -ne 3) { throw 'Same or absent previous installation caused work.' }
`);
  assert.match(output, /Vorherige Bridge-Prozesse beendet: 2/u);
});

test('relocation finish refuses old or changed registration and ambiguous arguments before stopping any process', windows, async t => {
  const { run } = await fixture(t);
  await run(`
foreach ($kind in @('old-registration','ambiguous','changed-registration')) {
    $script:stopped = @()
    $script:key.Value = if ($kind -eq 'old-registration') { $script:oldManifest } else { $script:newManifest }
    $script:processes = @((New-FixtureProcess 101 $script:oldRoot))
    if ($kind -eq 'ambiguous') { $script:processes += New-FixtureProcess 999 $script:oldRoot 'native-host.mjs' '--unexpected' }
    if ($kind -eq 'changed-registration') {
        function Get-FirefoxBridgeProcesses { $script:key.Value = $script:oldManifest; return $script:processes }
    }
    $rejected = $false
    try { Stop-FirefoxPreviousInstallation -PreviousManifest $script:oldManifest -CurrentRoot $script:currentRoot } catch { $rejected = $true }
    if (-not $rejected -or $script:stopped.Count -ne 0) { throw "Unsafe finish accepted: $kind" }
}
`);
});

test('relocation finish preserves unreadable processes and retains a clear restart instruction', windows, async t => {
  const { run } = await fixture(t);
  const output = await run(`
$script:processes = @([pscustomobject]@{ Name = 'node.exe'; ProcessId = 999; CommandLine = $null })
Stop-FirefoxPreviousInstallation -PreviousManifest $script:oldManifest -CurrentRoot $script:currentRoot
if ($script:stopped.Count -ne 0) { throw 'Unreadable process was stopped.' }
`);
  assert.match(output, /nicht lesbar.*neu starten/u);
});
