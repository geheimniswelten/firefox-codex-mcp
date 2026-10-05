import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildPayload, decodePayload, encodePayload, extractPayload } from '../scripts/companion-payload.mjs';
import { buildSetupDownloads } from '../scripts/build-setup-downloads.mjs';
import { defaultInstallationRoot, parseInstallArgs } from '../scripts/install-companion.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeRegistry = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\de.codex.firefox_bridge';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'firefox-setup-download-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('standalone archive roundtrips exact companion sources, excludes local secrets and dependencies', async () => {
  const payload = await buildPayload(project), encoded = encodePayload(payload);
  assert.deepEqual(decodePayload(encoded.base64, encoded.sha256), payload);
  assert.deepEqual(encodePayload(payload), encoded, 'reproducible compressed payload');
  assert.ok(payload.files.some(file => file.path === 'scripts/registration.mjs'));
  assert.ok(payload.files.some(file => file.path === 'server/mcp.mjs'));
  assert.ok(payload.files.every(file => !/^(?:\.local|node_modules|work|extension)\//.test(file.path)));
  for (const file of payload.files) assert.deepEqual(Buffer.from(file.data, 'base64'), await readFile(join(project, file.path)));
  assert.throws(() => decodePayload(encoded.base64, '0'.repeat(64)), /checksum/);
  const traversal = structuredClone(payload);
  traversal.files[0].path = '../outside.txt';
  assert.throws(() => encodePayload(traversal), /path/);
});

test('payload extraction preserves local configuration and rejects unrelated applications', async t => {
  const directory = await fixture(t), root = join(directory, 'installed');
  const payload = await buildPayload(project);
  await mkdir(join(root, '.local'), { recursive: true });
  await writeFile(join(root, '.local', 'config.json'), '{"keep":"secret"}');
  await extractPayload(payload, root);
  assert.equal(await readFile(join(root, '.local', 'config.json'), 'utf8'), '{"keep":"secret"}');
  await extractPayload(payload, root);
  const foreign = join(directory, 'foreign');
  await mkdir(foreign);
  await writeFile(join(foreign, 'package.json'), '{"name":"another-app"}');
  await assert.rejects(extractPayload(payload, foreign), /another application/);
  assert.equal(await readFile(join(foreign, 'package.json'), 'utf8'), '{"name":"another-app"}');
});

test('payload rejects linked destination files before updating earlier companion files', async t => {
  const directory = await fixture(t), root = join(directory, 'installed'), outside = join(directory, 'outside');
  const payload = await buildPayload(project);
  await mkdir(join(root, 'server'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'package.json'), '{"name":"firefox-codex-mcp","marker":"keep"}');
  try { await symlink(join(outside, 'native-host.mjs'), join(root, 'server', 'native-host.mjs')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlinks are not permitted by Windows.'); return; } throw error; }
  await assert.rejects(extractPayload(payload, root), /ordinary/);
  assert.match(await readFile(join(root, 'package.json'), 'utf8'), /keep/);
});

test('installer defaults and arguments support desktop platforms and spaced paths', () => {
  const home = resolve(tmpdir(), 'person');
  assert.equal(defaultInstallationRoot('linux', home), join(home, '.local', 'share', 'firefox-codex-mcp'));
  assert.equal(defaultInstallationRoot('darwin', home), join(home, 'Library', 'Application Support', 'FirefoxCodexMCP'));
  assert.equal(defaultInstallationRoot('win32', home, { LOCALAPPDATA: join(home, 'Local') }), join(home, 'Local', 'FirefoxCodexMCP'));
  assert.throws(() => defaultInstallationRoot('android', home), /supports/);
  assert.throws(() => parseInstallArgs(['--root', 'relative']), /absolute/);
  assert.throws(() => parseInstallArgs(['--remove', '--port', '38477']), /--remove/);
  assert.throws(() => parseInstallArgs(['--port', '38477junk']), /between/);
  assert.equal(parseInstallArgs(['--root', resolve(tmpdir(), 'with spaces'), '--no-register-clients']).noClients, true);
});

test('payload refuses hardlinked source files without changing their external link', async t => {
  const directory = await fixture(t), root = join(directory, 'installed'), external = join(directory, 'external.js');
  await mkdir(join(root, 'server'), { recursive: true });
  await writeFile(external, 'keep outside');
  await link(external, join(root, 'server', 'native-host.mjs'));
  await assert.rejects(extractPayload(await buildPayload(project), root), /ordinary/);
  assert.equal(await readFile(external, 'utf8'), 'keep outside');
});

test('generated downloads contain the same checked version and shell JavaScript parses', async () => {
  await buildSetupDownloads(project);
  const manifest = JSON.parse(await readFile(join(project, 'extension/setup/payload-manifest.json'), 'utf8'));
  for (const name of ['register.ps1', 'unregister.ps1', 'register.sh', 'unregister.sh']) {
    const source = await readFile(join(project, 'extension/setup', name), 'utf8');
    assert.ok(source.includes(manifest.version));
    assert.doesNotMatch(source, /__[A-Z_]+__/);
    if (name.endsWith('.sh')) {
      const marker = name === 'register.sh' ? 'FIREFOX_COMPANION_JS' : 'FIREFOX_DEREGISTER_JS';
      const code = source.split("<<'" + marker + "'\n")[1].split('\n' + marker)[0];
      const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: code, encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
    }
  }
});

test('PowerShell 5.1 generated register script extracts exact payload into an isolated directory', { skip: process.platform !== 'win32' }, async t => {
  await buildSetupDownloads(project);
  const directory = await fixture(t), output = join(directory, "target O'Brien");
  const script = join(project, 'extension/setup/register.ps1');
  const code = [
    '$ErrorActionPreference = "Stop"',
    '$tokens=$null; $errors=$null',
    '$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:FIREFOX_MCP_TEST_DOWNLOAD,[ref]$tokens,[ref]$errors)',
    'if($errors.Count -gt 0){throw ($errors | Out-String)}',
    '$functions=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false)',
    'foreach($function in $functions){Invoke-Expression $function.Extent.Text}',
    'Expand-FirefoxSetupPayload -Root $env:FIREFOX_MCP_TEST_OUTPUT',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, FIREFOX_MCP_TEST_DOWNLOAD: script, FIREFOX_MCP_TEST_OUTPUT: output },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = await buildPayload(project);
  for (const file of payload.files) assert.deepEqual(await readFile(join(output, file.path)), Buffer.from(file.data, 'base64'));
  const help = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(help.status, 0, help.stderr);
  const unregister = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(project, 'extension/setup/unregister.ps1'), '-Help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(unregister.status, 0, unregister.stderr);
});

test('Windows download path selection refuses drive-relative paths and normalizes trailing separators', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t);
  const common = await readFile(join(project, 'scripts/templates/setup-common.ps1'), 'utf8');
  const probe = join(directory, 'probe.ps1');
  await writeFile(probe, common + '\ntry { Get-FirefoxSetupRoot -RequestedRoot $env:FIREFOX_MCP_TEST_ROOT } catch { Write-Output "REJECTED"; exit 7 }\n');
  for (const bad of ['C:relative', '\\relative', 'relative']) {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe], { env: { ...process.env, FIREFOX_MCP_TEST_ROOT: bad }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(run.status, 7, run.stderr || run.stdout);
  }
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe], { env: { ...process.env, FIREFOX_MCP_TEST_ROOT: directory + '\\' }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), directory);
});

test('Windows self-contained download calls installed setup with named switches and preserves external hardlinks', { skip: process.platform !== 'win32' }, async t => {
  const directory = await fixture(t), output = join(directory, 'companion'), outside = join(directory, 'outside.js');
  await mkdir(join(output, 'server'), { recursive: true });
  await writeFile(outside, 'external file stays untouched');
  await link(outside, join(output, 'server/native-host.mjs'));
  const payload = await buildPayload(project);
  const stub = Buffer.from("param([switch]$NoOpenFirefox,[switch]$NoDownload,[switch]$NoRegisterClients,[int]$Port)\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'called.json'),(@{NoOpenFirefox=$NoOpenFirefox.IsPresent;NoDownload=$NoDownload.IsPresent;NoRegisterClients=$NoRegisterClients.IsPresent;Port=$Port}|ConvertTo-Json -Compress))\n$global:LASTEXITCODE=0\n");
  const { createHash } = await import('node:crypto');
  const entry = payload.files.find(file => file.path === 'install.ps1');
  entry.data = stub.toString('base64');
  entry.sha256 = createHash('sha256').update(stub).digest('hex');
  const archive = encodePayload(payload);
  let common = await readFile(join(project, 'scripts/templates/setup-common.ps1'), 'utf8');
  // Registry discovery is the sole OS boundary replaced in this isolated test.
  common += '\nfunction Get-FirefoxInstalledRoot { return $null }\n';
  let source = await readFile(join(project, 'scripts/templates/register.ps1'), 'utf8');
  for (const [marker, value] of Object.entries({ __COMMON_PS__: common, __VERSION__: payload.version, __REVISION__: '1', __PAYLOAD__: archive.base64, __PAYLOAD_SHA__: archive.sha256 })) source = source.replaceAll(marker, () => value);
  const script = join(directory, 'register.ps1');
  await writeFile(script, source);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProjectRoot', output, '-NoDownload', '-NoRegisterClients', '-Port', '43210'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'called.json'), 'utf8')), { NoOpenFirefox: true, NoDownload: true, NoRegisterClients: true, Port: 43210 });
  assert.equal(await readFile(outside, 'utf8'), 'external file stays untouched');
  assert.deepEqual(await readFile(join(output, 'server/native-host.mjs')), Buffer.from(payload.files.find(file => file.path === 'server/native-host.mjs').data, 'base64'));
});

async function windowsUnregisterFixture(t, { manifest, requestedRoot, registeredManifestPath, receiptOverrides = {}, scenario = '', clients = false, registrar = false } = {}) {
  const directory = await fixture(t), oldRoot = join(directory, 'old missing companion'), newRoot = join(directory, 'current companion');
  const manifestPath = join(oldRoot, '.local', 'de.codex.firefox_bridge.json');
  const removed = join(directory, 'registry-removed.txt'), called = join(directory, 'clients-called.json');
  await mkdir(newRoot, { recursive: true });
  if (manifest !== undefined) {
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest === true ? { name: 'de.codex.firefox_bridge', type: 'stdio', allowed_extensions: ['firefox-codex-mcp@local.invalid'], path: join(oldRoot, '.local', 'native-host.cmd') } : manifest));
    await writeFile(join(oldRoot, '.local', 'registration-status.json'), JSON.stringify({ schemaVersion: 1, platform: 'win', registrationRevision: 1, installerVersion: '1.0.5', registeredAt: '2026-10-05T12:00:00.000Z', manifestPath, registrationPath: nativeRegistry, ...receiptOverrides }));
  }
  if (registrar) {
    await mkdir(join(newRoot, 'scripts'));
    await writeFile(join(newRoot, 'scripts', 'configure-clients.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.FIREFOX_MCP_TEST_CALLED, JSON.stringify(process.argv.slice(2)));`);
  }
  // Replace every registry operation at the OS boundary. Tests never access the
  // user's real key, and the removal mock rejects recursive operations.
  const mock = String.raw`
$global:registrationReads = 0
function Get-Item {
    [CmdletBinding()] param([string]$LiteralPath, [switch]$Force)
    if ($LiteralPath -ne 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge') { return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction SilentlyContinue }
    if ($env:FIREFOX_MCP_TEST_SCENARIO -eq 'absent') { return $null }
    $global:registrationReads++
    $value = $env:FIREFOX_MCP_TEST_MANIFEST
    if ($env:FIREFOX_MCP_TEST_SCENARIO -eq 'changed' -and $global:registrationReads -gt 1) { $value = $env:FIREFOX_MCP_TEST_ALTERNATE }
    $names = @('')
    if ($env:FIREFOX_MCP_TEST_SCENARIO -eq 'extra-value' -or ($env:FIREFOX_MCP_TEST_SCENARIO -eq 'changed-extra-value' -and $global:registrationReads -gt 1)) { $names += 'external' }
    $key = [pscustomobject]@{ Value = $value; Names = $names }
    $key | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($name) return $this.Value }
    $key | Add-Member -MemberType ScriptMethod -Name GetValueNames -Value { return $this.Names }
    $key | Add-Member -MemberType ScriptMethod -Name GetValueKind -Value { param($name) return [Microsoft.Win32.RegistryValueKind]::String }
    return $key
}
function Get-ChildItem {
    [CmdletBinding()] param([string]$LiteralPath)
    if ($LiteralPath -ne 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge') { throw 'Unexpected child enumeration in registry test.' }
    if ($env:FIREFOX_MCP_TEST_SCENARIO -eq 'child-key') { return 'external-child' }
}
function Remove-Item {
    [CmdletBinding()] param([string]$LiteralPath, [switch]$Force, [switch]$Recurse)
    if ($Recurse) { throw 'Recursive removal is forbidden.' }
    if ($LiteralPath -eq 'HKCU:\Software\Mozilla\NativeMessagingHosts\de.codex.firefox_bridge') { [IO.File]::WriteAllText($env:FIREFOX_MCP_TEST_REMOVED, 'removed'); return }
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Force:$Force
}
function Get-Command {
    [CmdletBinding()] param([string]$Name, [switch]$All, [string]$CommandType)
    if ($env:FIREFOX_MCP_TEST_SCENARIO -ne 'no-node') { return [pscustomobject]@{ Source = $env:FIREFOX_MCP_TEST_NODE } }
}
`;
  const common = await readFile(join(project, 'scripts/templates/setup-common.ps1'), 'utf8');
  const source = (await readFile(join(project, 'scripts/templates/unregister.ps1'), 'utf8')).replace('__COMMON_PS__', () => common + mock);
  const script = join(newRoot, 'unregister.ps1'); await writeFile(script, source);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (requestedRoot !== false) args.push('-ProjectRoot', requestedRoot || newRoot);
  if (!clients) args.push('-NoRegisterClients');
  const result = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000,
    cwd: directory, env: { ...process.env, FIREFOX_MCP_TEST_MANIFEST: registeredManifestPath || manifestPath, FIREFOX_MCP_TEST_ALTERNATE: join(newRoot, '.local', 'de.codex.firefox_bridge.json'), FIREFOX_MCP_TEST_SCENARIO: scenario, FIREFOX_MCP_TEST_REMOVED: removed, FIREFOX_MCP_TEST_CALLED: called, FIREFOX_MCP_TEST_NODE: process.execPath },
  });
  return { result, directory, oldRoot, newRoot, manifestPath, removed, called };
}

test('Windows standalone unregister discovers missing old installations and ignores an explicit new root without Node', { skip: process.platform !== 'win32' }, async t => {
  const f = await windowsUnregisterFixture(t, { scenario: 'no-node' });
  assert.equal(f.result.status, 0, f.result.stderr || f.result.stdout);
  assert.equal(await readFile(f.removed, 'utf8'), 'removed');
  assert.match(f.result.stdout, /Native Host deregistered/u);
  const missingDrive = await windowsUnregisterFixture(t, { scenario: 'no-node', registeredManifestPath: 'Y:\\no-longer-mounted-firefox-companion\\.local\\de.codex.firefox_bridge.json' });
  assert.equal(missingDrive.result.status, 0, missingDrive.result.stderr || missingDrive.result.stdout);
  assert.equal(await readFile(missingDrive.removed, 'utf8'), 'removed');
});

test('Windows standalone unregister removes an old valid receipt and uses the current parser for discovered client cleanup', { skip: process.platform !== 'win32' }, async t => {
  const f = await windowsUnregisterFixture(t, { manifest: true, clients: true, registrar: true });
  assert.equal(f.result.status, 0, f.result.stderr || f.result.stdout);
  assert.equal(await readFile(f.removed, 'utf8'), 'removed');
  assert.deepEqual(JSON.parse(await readFile(f.called, 'utf8')), ['--root', f.oldRoot, '--remove', '--discover']);
  await assert.rejects(readFile(join(f.oldRoot, '.local', 'registration-status.json')), { code: 'ENOENT' });
  assert.match(await readFile(f.manifestPath, 'utf8'), /de\.codex\.firefox_bridge/u);
});

test('Windows standalone unregister preserves foreign manifests, additional values, child keys and changed snapshots', { skip: process.platform !== 'win32' }, async t => {
  for (const options of [{ manifest: { name: 'another.application' } }, { scenario: 'extra-value' }, { scenario: 'child-key' }, { scenario: 'changed' }, { scenario: 'changed-extra-value' }]) {
    const f = await windowsUnregisterFixture(t, options);
    assert.equal(f.result.status, 1, f.result.stderr || f.result.stdout);
    await assert.rejects(readFile(f.removed), { code: 'ENOENT' });
    if (options.manifest) assert.deepEqual(JSON.parse(await readFile(f.manifestPath, 'utf8')), options.manifest);
  }
});

test('Windows standalone unregister preserves unknown, foreign and malformed receipt metadata', { skip: process.platform !== 'win32' }, async t => {
  for (const receiptOverrides of [{ schemaVersion: 99 }, { schemaVersion: '1' }, { platform: 'linux' }, { registrationPath: 'another registry' }, { registeredAt: '2026-99-99T12:00:00.000Z' }]) {
    const f = await windowsUnregisterFixture(t, { manifest: true, receiptOverrides });
    assert.equal(f.result.status, 0, f.result.stderr || f.result.stdout);
    assert.equal(await readFile(f.removed, 'utf8'), 'removed');
    const receipt = JSON.parse(await readFile(join(f.oldRoot, '.local', 'registration-status.json'), 'utf8'));
    for (const [key, value] of Object.entries(receiptOverrides)) assert.equal(receipt[key], value);
  }
});

test('Windows standalone unregister is idempotent when no native registration exists and reports optional cleanup separately', { skip: process.platform !== 'win32' }, async t => {
  const absent = await windowsUnregisterFixture(t, { scenario: 'absent', requestedRoot: false });
  assert.equal(absent.result.status, 0, absent.result.stderr || absent.result.stdout);
  await assert.rejects(readFile(absent.removed), { code: 'ENOENT' });
  const partial = await windowsUnregisterFixture(t, { scenario: 'no-node', clients: true });
  assert.equal(partial.result.status, 2, partial.result.stderr || partial.result.stdout);
  assert.equal(await readFile(partial.removed, 'utf8'), 'removed');
  assert.match(partial.result.stdout, /AI client entries could not be checked/u);
});

async function unixUnregisterFixture(t, { registered = true, foreign = false, clients = false } = {}) {
  const directory = await fixture(t), oldRoot = join(directory, 'missing old companion'), newRoot = join(directory, 'new companion'), home = join(directory, 'home');
  const registrationPath = join(home, '.mozilla', 'native-messaging-hosts', 'de.codex.firefox_bridge.json');
  const called = join(directory, 'clients-called.json');
  await mkdir(dirname(registrationPath), { recursive: true });
  await mkdir(join(newRoot, 'scripts'), { recursive: true });
  if (registered) await writeFile(registrationPath, JSON.stringify({ name: foreign ? 'another.application' : 'de.codex.firefox_bridge', type: 'stdio', allowed_extensions: ['firefox-codex-mcp@local.invalid'], path: join(oldRoot, '.local', 'native-host.sh') }));
  await writeFile(join(newRoot, 'scripts', 'client-config.mjs'), `import {writeFileSync} from 'node:fs'; export async function configureClients(options) { writeFileSync(process.env.FIREFOX_MCP_TEST_CALLED, JSON.stringify(options)); return []; }`);
  const shell = await readFile(join(project, 'scripts/templates/unregister.sh'), 'utf8');
  const code = shell.split("<<'FIREFOX_DEREGISTER_JS'\n")[1].split('\nFIREFOX_DEREGISTER_JS')[0]
    .replace('const home = homedir();', 'const home = process.env.FIREFOX_MCP_TEST_HOME;')
    .replaceAll("process.platform === 'darwin'", 'false').replaceAll("process.platform === 'linux'", 'true');
  const result = spawnSync(process.execPath, ['--input-type=module', '-', newRoot, clients ? '' : '--no-register-clients', newRoot], {
    input: code, encoding: 'utf8', timeout: 10000, cwd: directory, env: { ...process.env, FIREFOX_MCP_TEST_HOME: home, FIREFOX_MCP_TEST_CALLED: called },
  });
  return { result, registrationPath, oldRoot, newRoot, called };
}

test('Unix standalone unregister discovers a deleted old companion independently of --root and uses a current client parser', async t => {
  const f = await unixUnregisterFixture(t, { clients: true });
  assert.equal(f.result.status, 0, f.result.stderr || f.result.stdout);
  await assert.rejects(readFile(f.registrationPath), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(f.called, 'utf8')), { root: f.oldRoot, remove: true, discover: true });
});

test('Unix standalone unregister succeeds without a registration and preserves foreign manifest content', async t => {
  const absent = await unixUnregisterFixture(t, { registered: false, clients: true });
  assert.equal(absent.result.status, 0, absent.result.stderr || absent.result.stdout);
  assert.deepEqual(JSON.parse(await readFile(absent.called, 'utf8')), { root: absent.newRoot, remove: true, discover: true });
  const foreign = await unixUnregisterFixture(t, { foreign: true });
  assert.notEqual(foreign.result.status, 0);
  assert.equal(JSON.parse(await readFile(foreign.registrationPath, 'utf8')).name, 'another.application');
});
