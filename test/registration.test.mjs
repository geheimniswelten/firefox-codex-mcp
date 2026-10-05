import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, link, readdir, stat, symlink, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST_NAME, EXTENSION_ID, INSTALLER_VERSION, REGISTRATION_REVISION, REQUIRED_REGISTRATION_REVISION, registrationPlatform, nativeRegistrationPath, registerNativeHost, unregisterNativeHost, readRegistrationStatus, writeRegistrationStatus, clearRegistrationStatus, registrationStatusPath } from '../scripts/registration.mjs';

async function fixture(t, platform = 'linux') {
  const root = await mkdtemp(join(tmpdir(), 'firefox-mcp-registration-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('firefox-mcp-registration-'));
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'home'), local = join(root, 'installation', '.local');
  await mkdir(home, { recursive: true }); await mkdir(local, { recursive: true });
  const manifestPath = join(local, `${HOST_NAME}.json`), configPath = join(local, 'config.json');
  const manifest = { name: HOST_NAME, description: 'Lokale Firefox-Brücke für Codex MCP', type: 'stdio', path: join(local, platform === 'win' ? 'native-host.cmd' : 'native-host.sh'), allowed_extensions: [EXTENSION_ID] };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, text); await writeFile(configPath, '{"port":38477,"token":"never-in-the-receipt"}');
  await writeFile(manifest.path, '#!/bin/sh\nexit 0\n');
  return { root, home, local, manifestPath, configPath, manifest, text };
}
function registry(initial = { exists: false }) {
  let state = structuredClone(initial);
  const calls = [];
  return {
    calls, state: () => structuredClone(state), setState: next => { state = structuredClone(next); },
    async read() { calls.push('read'); return structuredClone(state); },
    async write(value) { calls.push(['write', value]); state = { exists: true, value, hasChildren: false }; },
    async replace(expected, value) {
      calls.push(['replace', expected, value]);
      assert.equal(state.exists, true);
      assert.equal(state.value.toLowerCase(), expected.toLowerCase());
      assert.equal(state.hasChildren, false); assert.equal(state.hasExtraValues, false);
      state = { exists: true, value, hasChildren: false, hasExtraValues: false };
    },
    async remove(expected) { calls.push(['remove', expected]); assert.equal(state.value, expected); state = { exists: false }; }
  };
}
const receipt = result => ({ schemaVersion: 1, registrationRevision: REGISTRATION_REVISION, installerVersion: INSTALLER_VERSION, registeredAt: '2026-10-04T12:00:00.000Z', platform: result.platform, manifestPath: result.manifestPath, registrationPath: result.registrationPath });
const ownedRegistry = value => ({ exists: true, value, hasChildren: false, hasExtraValues: false });
const oldManifestPath = f => join(f.root, 'previous-installation', '.local', `${HOST_NAME}.json`);
async function oldManifest(f, platform = 'win', patch = {}) {
  const path = oldManifestPath(f);
  await mkdir(dirname(path), { recursive: true });
  const value = { ...f.manifest, path: join(dirname(path), platform === 'win' ? 'native-host.cmd' : 'native-host.sh'), ...patch };
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, text);
  return { path, value, text };
}

test('registration platforms and native manifest locations are explicit and per-user', async t => {
  const { home } = await fixture(t);
  assert.deepEqual(REQUIRED_REGISTRATION_REVISION, { win: 1, linux: 1, mac: 1 });
  assert.equal(registrationPlatform('win32'), 'win'); assert.equal(registrationPlatform('darwin'), 'mac');
  assert.throws(() => registrationPlatform('freebsd'), { code: 'UNSUPPORTED_PLATFORM' });
  assert.equal(nativeRegistrationPath({ platform: 'linux', home }), join(home, '.mozilla', 'native-messaging-hosts', `${HOST_NAME}.json`));
  assert.equal(nativeRegistrationPath({ platform: 'darwin', home }), join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts', `${HOST_NAME}.json`));
  assert.equal(nativeRegistrationPath({ platform: 'win32', home }), `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`);
});

test('Linux and macOS register a complete manifest, read it back, reuse it and remove only their own native registration', async t => {
  for (const platform of ['linux', 'mac']) {
    const f = await fixture(t);
    const registered = await registerNativeHost({ ...f, platform });
    assert.equal(registered.changed, true);
    assert.equal(registered.registered, true);
    assert.equal(await readFile(registered.registrationPath, 'utf8'), f.text);
    assert.equal(await readRegistrationStatus(f.configPath), null, 'registration API does not invent a setup receipt');
    const reused = await registerNativeHost({ ...f, platform });
    assert.equal(reused.changed, false);
    const foreignPath = join(dirname(registered.registrationPath), 'another-host.json');
    await writeFile(foreignPath, 'foreign');
    const preview = await unregisterNativeHost({ ...f, platform, dryRun: true });
    assert.equal(preview.changed, true); assert.equal(await readFile(registered.registrationPath, 'utf8'), f.text);
    const removed = await unregisterNativeHost({ ...f, platform });
    assert.equal(removed.changed, true);
    await assert.rejects(readFile(registered.registrationPath), { code: 'ENOENT' });
    assert.equal(await readFile(f.manifestPath, 'utf8'), f.text);
    assert.equal(await readFile(foreignPath, 'utf8'), 'foreign');
    assert.equal((await unregisterNativeHost({ ...f, platform })).changed, false);
  }
});

test('Unix conflicts preserve different installations, malformed and modified manifests, and linked files', async t => {
  for (const variant of ['other-path', 'invalid', 'extra-extension', 'description', 'hardlink']) {
    const f = await fixture(t), target = nativeRegistrationPath({ platform: 'linux', home: f.home });
    await mkdir(dirname(target), { recursive: true });
    let content;
    if (variant === 'invalid') content = '{invalid';
    else if (variant === 'hardlink') { await link(f.manifestPath, target); content = f.text; }
    else {
      const value = { ...f.manifest, allowed_extensions: [...f.manifest.allowed_extensions] };
      if (variant === 'other-path') value.path = join(f.root, 'foreign-host.sh');
      if (variant === 'extra-extension') value.allowed_extensions.push('other@extension');
      if (variant === 'description') value.description = 'User-changed manifest';
      content = JSON.stringify(value);
    }
    if (variant !== 'hardlink') await writeFile(target, content);
    await assert.rejects(registerNativeHost({ ...f, platform: 'linux' }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    await assert.rejects(unregisterNativeHost({ ...f, platform: 'linux' }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    assert.equal(await readFile(target, 'utf8'), content);
  }
});

test('Unix removal can identify a standard registered installation after its generated manifest is missing', async t => {
  const f = await fixture(t);
  const result = await registerNativeHost({ ...f, platform: 'mac' });
  await unlink(f.manifestPath);
  const removed = await unregisterNativeHost({ ...f, platform: 'mac' });
  assert.equal(removed.changed, true);
  await assert.rejects(readFile(result.registrationPath), { code: 'ENOENT' });
  assert.equal(await readFile(f.manifest.path, 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('Windows adapter registration verifies readback and never overwrites foreign registry values or children', async t => {
  const f = await fixture(t), adapter = registry();
  const registered = await registerNativeHost({ ...f, platform: 'win', registryAdapter: adapter });
  assert.equal(registered.changed, true);
  assert.deepEqual(adapter.calls, ['read', ['write', f.manifestPath], 'read']);
  assert.equal((await registerNativeHost({ ...f, platform: 'win', registryAdapter: adapter })).changed, false);
  for (const state of [{ exists: true, value: join(f.root, 'other.json') }, { exists: true, value: '' }, { exists: true, value: f.manifestPath, hasChildren: true }, { exists: true, value: f.manifestPath, hasExtraValues: true }]) {
    const foreign = registry(state);
    await assert.rejects(registerNativeHost({ ...f, platform: 'win', registryAdapter: foreign }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    await assert.rejects(unregisterNativeHost({ ...f, platform: 'win', registryAdapter: foreign }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    assert.ok(foreign.calls.every(call => call === 'read'));
    assert.deepEqual(foreign.state(), state);
  }
  const lostWrite = registry(); lostWrite.write = async () => {};
  await assert.rejects(registerNativeHost({ ...f, platform: 'win', registryAdapter: lostWrite }), { code: 'NATIVE_REGISTRATION_FAILED' });
});

test('Windows explicit repair backs up a missing old installation before replacing the exact expected value', async t => {
  const f = await fixture(t, 'win'), previous = oldManifestPath(f);
  const adapter = registry(ownedRegistry(previous.toUpperCase()));
  const replace = adapter.replace;
  let backupPath;
  adapter.replace = async (...args) => {
    const backups = (await readdir(f.local)).filter(name => name.startsWith('native-registration-backup-'));
    assert.equal(backups.length, 1, 'a complete backup exists before registry mutation');
    backupPath = join(f.local, backups[0]);
    const text = await readFile(backupPath, 'utf8'), backup = JSON.parse(text);
    assert.equal(backup.previousManifestPath, previous.toUpperCase());
    assert.equal(backup.manifestPath, f.manifestPath);
    assert.equal(backup.registrationPath, nativeRegistrationPath({ platform: 'win' }));
    assert.equal(new Date(backup.backedUpAt).toISOString(), backup.backedUpAt);
    assert.ok(!text.includes('token')); assert.ok(!text.includes('never-in-the-receipt'));
    if (process.platform !== 'win32') assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    await replace(...args);
  };
  const result = await registerNativeHost({ ...f, platform: 'win', registryAdapter: adapter, replaceManifestPath: previous });
  assert.equal(result.changed, true); assert.equal(result.backupPath, backupPath);
  assert.equal(result.previousManifestPath, previous.toUpperCase());
  assert.deepEqual(adapter.calls, ['read', ['replace', previous, f.manifestPath], 'read']);
  assert.equal(adapter.state().value, f.manifestPath);
});

test('Windows production registry adapter writes and relocates with writable PowerShell 5.1 handles, then discovers removal', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'win');
  const name = `${HOST_NAME}.test_${randomUUID().replaceAll('-', '')}`;
  assert.match(name, /^de\.codex\.firefox_bridge\.test_[a-f0-9]{32}$/u);
  assert.notEqual(name, HOST_NAME);
  const registryPath = `HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\${name}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  Object.assign(env, { FIREFOX_MCP_TEST_NONCE_HOST: name, FIREFOX_MCP_TEST_NONCE_KEY: registryPath });
  const systemPowershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const guard = '$ErrorActionPreference="Stop"\n$name=$env:FIREFOX_MCP_TEST_NONCE_HOST\nif($name -cnotmatch "^de\\.codex\\.firefox_bridge\\.test_[a-f0-9]{32}$"){throw "Unsafe nonce host."}\n$target="HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\"+$name\nif($target -cne $env:FIREFOX_MCP_TEST_NONCE_KEY -or $name -ceq "de.codex.firefox_bridge"){throw "Unsafe nonce registry target."}\n';
  const ps = (script, extraEnv = {}) => execFileSync(systemPowershell, ['-NoProfile', '-NonInteractive', '-Command', guard + script], { env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
  const snapshot = () => JSON.parse(ps('if(Test-Path -LiteralPath $target){$key=Get-Item -LiteralPath $target;try{@{exists=$true;value=$key.GetValue("",$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);children=$key.SubKeyCount;names=@($key.GetValueNames());version=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress}finally{$key.Close()}}else{@{exists=$false;version=$PSVersionTable.PSVersion.ToString()}|ConvertTo-Json -Compress}'));
  const initial = snapshot();
  assert.equal(initial.exists, false, 'the unpredictable isolated test key must not exist before registration');
  assert.match(initial.version, /^5\.1\./u);
  t.after(() => {
    // Never recurse or remove the NativeMessagingHosts parent or the live host.
    ps('if(Test-Path -LiteralPath $target){$key=Get-Item -LiteralPath $target;try{if($key.SubKeyCount -ne 0){throw "Nonce key unexpectedly contains children."}}finally{$key.Close()};Remove-Item -LiteralPath $target -Force}');
    assert.equal(snapshot().exists, false);
  });
  const source = await readFile(fileURLToPath(new URL('../scripts/registration.mjs', import.meta.url)), 'utf8');
  const declaration = `export const HOST_NAME = '${HOST_NAME}';`;
  assert.equal(source.split(declaration).length, 2, 'only the constant host name may be substituted');
  const copiedModule = join(f.root, 'registration-isolated.mjs');
  await writeFile(copiedModule, source.replace(declaration, `export const HOST_NAME = '${name}';`));
  const isolated = await import(pathToFileURL(copiedModule).href);
  assert.equal(isolated.HOST_NAME, name);
  assert.equal(isolated.nativeRegistrationPath({ platform: 'win' }), registryPath.replace('HKCU:', 'HKCU'));
  const oldPath = join(f.root, 'old production installation', '.local', `${name}.json`);
  const newPath = join(f.local, `${name}.json`);
  for (const path of [oldPath, newPath]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ ...f.manifest, name, path: join(dirname(path), 'native-host.cmd') }));
  }
  const registered = await isolated.registerNativeHost({ manifestPath: oldPath, platform: 'win' });
  assert.equal(registered.changed, true); assert.equal(snapshot().value, oldPath);
  const moved = await isolated.registerNativeHost({ manifestPath: newPath, platform: 'win', relocate: true });
  assert.equal(moved.changed, true); assert.equal(moved.previousManifestPath, oldPath);
  assert.equal(snapshot().value, newPath); assert.equal(snapshot().children, 0);
  const backup = JSON.parse(await readFile(moved.backupPath, 'utf8'));
  assert.equal(backup.previousManifestPath, oldPath); assert.equal(backup.manifestPath, newPath);
  assert.equal(backup.registrationPath, isolated.nativeRegistrationPath({ platform: 'win' }));
  const acl = JSON.parse(ps('$acl=[IO.File]::GetAccessControl($env:FIREFOX_MCP_TEST_BACKUP);@{protected=$acl.AreAccessRulesProtected;identities=@($acl.Access|ForEach-Object{$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value});user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value}|ConvertTo-Json -Compress', { FIREFOX_MCP_TEST_BACKUP: moved.backupPath }));
  assert.equal(acl.protected, true);
  assert.deepEqual(acl.identities.sort(), ['S-1-5-18', acl.user].sort());
  const removed = await isolated.unregisterNativeHost({ manifestPath: oldPath, platform: 'win', discover: true });
  assert.equal(removed.manifestPath, newPath); assert.equal(removed.changed, true);
  assert.equal(snapshot().exists, false);
});

test('Windows relocation discovers the old registration while the default reports both paths without changing it', async t => {
  for (const missing of [false, true]) {
    const f = await fixture(t, 'win'), previous = oldManifestPath(f);
    const old = missing ? null : await oldManifest(f);
    const adapter = registry(ownedRegistry(previous));
    await assert.rejects(registerNativeHost({ ...f, platform: 'win', registryAdapter: adapter }), error => {
      assert.equal(error.code, 'NATIVE_REGISTRATION_CONFLICT');
      assert.ok(error.message.includes(JSON.stringify(previous)));
      assert.ok(error.message.includes(JSON.stringify(f.manifestPath)));
      assert.ok(error.message.includes('--replace-native-manifest'));
      return true;
    });
    assert.equal(adapter.state().value, previous);
    const result = await registerNativeHost({ ...f, platform: 'win', registryAdapter: adapter, relocate: true });
    assert.equal(result.previousManifestPath, previous); assert.equal(result.changed, true);
    assert.ok(result.backupPath.startsWith(f.local));
    if (!missing) assert.equal(await readFile(previous, 'utf8'), old.text);
  }
});

test('Windows relocation accepts an unavailable old drive without accessing the real registration', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'win');
  let drive;
  for (const candidate of ['Z', 'Y', 'X', 'W', 'V', 'U']) {
    try { await lstat(`${candidate}:\\`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; drive = `${candidate}:\\`; break; }
  }
  if (!drive) { t.skip('No absent test drive available.'); return; }
  const previous = join(drive, 'missing-firefox-mcp-installation', '.local', `${HOST_NAME}.json`);
  const adapter = registry(ownedRegistry(previous));
  const moved = await registerNativeHost({ ...f, platform: 'win', registryAdapter: adapter, relocate: true });
  assert.equal(moved.previousManifestPath, previous); assert.equal(adapter.state().value, f.manifestPath);
  adapter.setState(ownedRegistry(previous));
  await unregisterNativeHost({ ...f, platform: 'win', registryAdapter: adapter, discover: true });
  assert.equal(adapter.state().exists, false);
});

test('Windows replacement cannot create a missing entry or overwrite unexpected values, children or extra values', async t => {
  const f = await fixture(t, 'win'), previous = oldManifestPath(f);
  for (const state of [
    { exists: false, hasChildren: false, hasExtraValues: false },
    ownedRegistry(join(f.root, 'foreign.json')),
    ownedRegistry(f.manifestPath),
    { ...ownedRegistry(previous), hasChildren: true },
    { ...ownedRegistry(previous), hasExtraValues: true },
    { exists: true, value: previous, hasChildren: false }
  ]) {
    const adapter = registry(state);
    await assert.rejects(registerNativeHost({ ...f, platform: 'win', registryAdapter: adapter, replaceManifestPath: previous }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    assert.deepEqual(adapter.state(), state); assert.deepEqual(adapter.calls, ['read']);
  }
  assert.ok(!(await readdir(f.local)).some(name => name.startsWith('native-registration-backup-')));
  await assert.rejects(registerNativeHost({ ...f, platform: 'win', replaceManifestPath: 'relative.json' }), { code: 'INVALID_REGISTRATION_PATH' });
  await assert.rejects(registerNativeHost({ ...f, platform: 'linux', replaceManifestPath: previous }), { code: 'INVALID_REGISTRATION_REPLACEMENT' });
});

test('Windows relocation and discovery reject modified, foreign, linked or nonstandard old manifests', async t => {
  for (const variant of ['name', 'extension', 'path', 'extra-field', 'invalid', 'hardlink', 'symlink']) {
    const f = await fixture(t, 'win');
    const patch = variant === 'name' ? { name: 'foreign.host' } : variant === 'extension' ? { allowed_extensions: ['foreign@extension'] } : variant === 'path' ? { path: join(f.root, 'foreign.cmd') } : variant === 'extra-field' ? { unknown: true } : {};
    const previous = await oldManifest(f, 'win', patch);
    if (variant === 'invalid') await writeFile(previous.path, '{invalid');
    if (variant === 'hardlink') { await unlink(previous.path); await link(f.manifestPath, previous.path); }
    if (variant === 'symlink') {
      await unlink(previous.path);
      try { await symlink(f.manifestPath, previous.path, 'file'); }
      catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') continue; throw error; }
    }
    const adapter = registry(ownedRegistry(previous.path));
    await assert.rejects(registerNativeHost({ ...f, platform: 'win', registryAdapter: adapter, relocate: true }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    await assert.rejects(unregisterNativeHost({ ...f, platform: 'win', registryAdapter: adapter, discover: true }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    assert.ok(adapter.calls.every(call => call === 'read')); assert.equal(adapter.state().value, previous.path);
    assert.ok(!(await readdir(f.local)).some(name => name.startsWith('native-registration-backup-')));
  }
});

test('Windows replacement checks a race and confirms readback, retaining its recovery backup on failure', async t => {
  for (const variant of ['race', 'lost-write', 'foreign-readback']) {
    const f = await fixture(t, 'win'), previous = oldManifestPath(f), adapter = registry(ownedRegistry(previous));
    adapter.replace = async (expected, target) => {
      assert.equal(expected, previous); assert.equal(target, f.manifestPath);
      assert.equal((await readdir(f.local)).filter(name => name.startsWith('native-registration-backup-')).length, 1);
      if (variant === 'race') {
        adapter.setState(ownedRegistry(join(f.root, 'foreign.json')));
        throw Object.assign(new Error('Registration changed before replacement.'), { code: 'NATIVE_REGISTRATION_CONFLICT' });
      }
      if (variant === 'foreign-readback') adapter.setState(ownedRegistry(join(f.root, 'foreign.json')));
    };
    await assert.rejects(registerNativeHost({ ...f, platform: 'win', registryAdapter: adapter, relocate: true }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    assert.equal((await readdir(f.local)).filter(name => name.startsWith('native-registration-backup-')).length, 1);
    assert.notEqual(adapter.state().value, f.manifestPath);
  }
});

test('Unix relocation preserves the previous bytes and discovery unregisters relocated or deleted installations', async t => {
  for (const platform of ['linux', 'mac']) {
    const f = await fixture(t), previous = await oldManifest(f, platform);
    const target = nativeRegistrationPath({ platform, home: f.home });
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, previous.text);
    await assert.rejects(registerNativeHost({ ...f, platform }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    const moved = await registerNativeHost({ ...f, platform, relocate: true });
    assert.equal(moved.changed, true); assert.equal(moved.previousManifestPath, previous.path);
    const backup = JSON.parse(await readFile(moved.backupPath, 'utf8'));
    assert.equal(Buffer.from(backup.previousManifestBase64, 'base64').toString('utf8'), previous.text);
    assert.equal(backup.registrationPath, target);
    assert.equal(await readFile(target, 'utf8'), f.text);
    assert.equal(await readFile(previous.path, 'utf8'), previous.text);
    for (const missing of [false, true]) {
      await writeFile(target, previous.text);
      if (missing) await unlink(previous.path);
      const preview = await unregisterNativeHost({ ...f, platform, discover: true, dryRun: true });
      assert.equal(preview.manifestPath, previous.path); assert.equal(preview.previousManifestPath, previous.path);
      assert.equal(await readFile(target, 'utf8'), previous.text);
      const removed = await unregisterNativeHost({ ...f, platform, discover: true });
      assert.equal(removed.manifestPath, previous.path); assert.equal(removed.changed, true);
      await assert.rejects(readFile(target), { code: 'ENOENT' });
    }
  }
});

test('Unix discovery and relocation preserve foreign launcher paths and changed source manifests', async t => {
  for (const platform of ['linux', 'mac']) {
    for (const variant of ['foreign-launcher', 'source-changed']) {
      const f = await fixture(t), previous = await oldManifest(f, platform);
      const target = nativeRegistrationPath({ platform, home: f.home });
      const text = variant === 'foreign-launcher' ? JSON.stringify({ ...previous.value, path: join(f.root, 'foreign-host.sh') }) : previous.text;
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, text);
      if (variant === 'source-changed') await writeFile(previous.path, JSON.stringify({ ...previous.value, allowed_extensions: ['foreign@extension'] }));
      await assert.rejects(registerNativeHost({ ...f, platform, relocate: true }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
      await assert.rejects(unregisterNativeHost({ ...f, platform, discover: true }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
      assert.equal(await readFile(target, 'utf8'), text);
    }
  }
});

test('Windows discovery removes the actual old registration after its generated files are deleted', async t => {
  for (const missing of [false, true]) {
    const f = await fixture(t, 'win'), previous = oldManifestPath(f);
    if (!missing) await oldManifest(f);
    const adapter = registry(ownedRegistry(previous));
    const preview = await unregisterNativeHost({ ...f, platform: 'win', registryAdapter: adapter, discover: true, dryRun: true });
    assert.equal(preview.manifestPath, previous); assert.equal(preview.previousManifestPath, previous);
    assert.deepEqual(adapter.calls, ['read']); assert.equal(adapter.state().value, previous);
    const removed = await unregisterNativeHost({ ...f, platform: 'win', registryAdapter: adapter, discover: true });
    assert.equal(removed.manifestPath, previous); assert.equal(removed.changed, true);
    assert.equal(adapter.state().exists, false);
  }
});

test('Windows discovered removal rechecks registry ownership and refuses unknown extra state', async t => {
  const f = await fixture(t, 'win'), previous = oldManifestPath(f);
  for (const state of [
    ownedRegistry(join(f.root, 'foreign.json')),
    { ...ownedRegistry(previous), hasChildren: true },
    { ...ownedRegistry(previous), hasExtraValues: true }
  ]) {
    const adapter = registry(state);
    await assert.rejects(unregisterNativeHost({ ...f, platform: 'win', registryAdapter: adapter, discover: true }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    assert.deepEqual(adapter.state(), state); assert.deepEqual(adapter.calls, ['read']);
  }
  const adapter = registry(ownedRegistry(previous));
  let reads = 0;
  adapter.read = async () => ++reads === 1 ? ownedRegistry(previous) : ownedRegistry(join(f.root, 'foreign.json'));
  await assert.rejects(unregisterNativeHost({ ...f, platform: 'win', registryAdapter: adapter, discover: true }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
  assert.equal(adapter.calls.length, 0);
});

test('Windows discovered removal checks that the old manifest did not change or appear after discovery', async t => {
  for (const initiallyMissing of [false, true]) {
    const f = await fixture(t, 'win'), previous = oldManifestPath(f);
    if (!initiallyMissing) await oldManifest(f);
    const adapter = registry(ownedRegistry(previous));
    let reads = 0;
    adapter.read = async () => {
      if (++reads === 2) await oldManifest(f, 'win', { allowed_extensions: ['foreign@extension'] });
      return ownedRegistry(previous);
    };
    await assert.rejects(unregisterNativeHost({ ...f, platform: 'win', registryAdapter: adapter, discover: true }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    assert.equal(adapter.state().value, previous); assert.equal(adapter.calls.length, 0);
  }
});

test('Windows deregistration previews without mutation, rechecks ownership, and verifies absence', async t => {
  const f = await fixture(t), adapter = registry({ exists: true, value: f.manifestPath });
  assert.equal((await unregisterNativeHost({ ...f, platform: 'win', registryAdapter: adapter, dryRun: true })).changed, true);
  assert.deepEqual(adapter.calls, ['read']);
  await unregisterNativeHost({ ...f, platform: 'win', registryAdapter: adapter });
  assert.equal(adapter.state().exists, false);
  const changed = registry({ exists: true, value: f.manifestPath });
  let reads = 0;
  changed.read = async () => ({ exists: true, value: ++reads === 1 ? f.manifestPath : join(f.root, 'foreign.json') });
  await assert.rejects(unregisterNativeHost({ ...f, platform: 'win', registryAdapter: changed }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
  assert.equal(changed.calls.length, 0, 'no removal after changed ownership');
  const retained = registry({ exists: true, value: f.manifestPath }); retained.remove = async () => {};
  await assert.rejects(unregisterNativeHost({ ...f, platform: 'win', registryAdapter: retained }), { code: 'NATIVE_REGISTRATION_FAILED' });
});

test('receipts round-trip known metadata without config tokens, preserve invalid files and clear only matching ownership', async t => {
  const f = await fixture(t);
  const registered = await registerNativeHost({ ...f, platform: 'linux' });
  const expected = receipt(registered);
  assert.equal(await readRegistrationStatus(f.configPath), null);
  await writeRegistrationStatus(f.configPath, { ...expected, token: 'must-not-be-serialized' });
  assert.deepEqual(await readRegistrationStatus(f.configPath), expected);
  const bytes = await readFile(registrationStatusPath(f.configPath), 'utf8');
  assert.ok(!bytes.includes('token')); assert.ok(!bytes.includes('never-in-the-receipt'));
  assert.equal(await clearRegistrationStatus(f.configPath, { ...registered, manifestPath: join(f.root, 'foreign.json') }), false);
  assert.equal(await readFile(registrationStatusPath(f.configPath), 'utf8'), bytes);
  assert.equal(await clearRegistrationStatus(f.configPath, { ...registered, dryRun: true }), true);
  assert.equal(await readFile(registrationStatusPath(f.configPath), 'utf8'), bytes);
  assert.equal(await clearRegistrationStatus(f.configPath, registered), true);
  assert.equal(await readRegistrationStatus(f.configPath), null);
  await writeFile(registrationStatusPath(f.configPath), '{invalid');
  assert.equal(await readRegistrationStatus(f.configPath), null);
  await assert.rejects(writeRegistrationStatus(f.configPath, expected), { code: 'REGISTRATION_STATUS_INVALID' });
  assert.equal(await clearRegistrationStatus(f.configPath, registered), false);
  assert.equal(await readFile(registrationStatusPath(f.configPath), 'utf8'), '{invalid');
});

test('invalid or linked receipts remain unverified and are never followed', async t => {
  const f = await fixture(t), result = await registerNativeHost({ ...f, platform: 'mac' });
  const valid = receipt(result);
  for (const patch of [{ schemaVersion: 2 }, { registrationRevision: 0 }, { registeredAt: 'not-a-date' }, { platform: 'other' }, { manifestPath: 'relative.json' }, { manifestPath: join(f.root, 'foreign.json') }, { registrationPath: 'relative.json' }]) {
    await writeFile(registrationStatusPath(f.configPath), JSON.stringify({ ...valid, ...patch }));
    assert.equal(await readRegistrationStatus(f.configPath), null);
  }
  await unlink(registrationStatusPath(f.configPath));
  await link(f.configPath, registrationStatusPath(f.configPath));
  assert.equal(await readRegistrationStatus(f.configPath), null);
  await assert.rejects(writeRegistrationStatus(f.configPath, valid), { code: 'NATIVE_REGISTRATION_CONFLICT' });
  assert.ok((await readFile(f.configPath, 'utf8')).includes('never-in-the-receipt'));
});
