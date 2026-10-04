import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildPayload, decodePayload, encodePayload, extractPayload } from '../scripts/companion-payload.mjs';
import { buildSetupDownloads } from '../scripts/build-setup-downloads.mjs';
import { defaultInstallationRoot, parseInstallArgs } from '../scripts/install-companion.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'firefox-setup-download-'));
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
