import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, link } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HOST_NAME, EXTENSION_ID, INSTALLER_VERSION, REGISTRATION_REVISION, REQUIRED_REGISTRATION_REVISION, registrationPlatform, nativeRegistrationPath, registerNativeHost, unregisterNativeHost, readRegistrationStatus, writeRegistrationStatus, clearRegistrationStatus, registrationStatusPath } from '../scripts/registration.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'firefox-mcp-registration-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('firefox-mcp-registration-'));
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'home'), local = join(root, 'installation', '.local');
  await mkdir(home, { recursive: true }); await mkdir(local, { recursive: true });
  const manifestPath = join(local, `${HOST_NAME}.json`), configPath = join(local, 'config.json');
  const manifest = { name: HOST_NAME, description: 'Lokale Firefox-Brücke für Codex MCP', type: 'stdio', path: join(local, 'native-host.sh'), allowed_extensions: [EXTENSION_ID] };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, text); await writeFile(configPath, '{"port":38477,"token":"never-in-the-receipt"}');
  await writeFile(manifest.path, '#!/bin/sh\nexit 0\n');
  return { root, home, local, manifestPath, configPath, manifest, text };
}
function registry(initial = { exists: false }) {
  let state = structuredClone(initial);
  const calls = [];
  return {
    calls, state: () => structuredClone(state),
    async read() { calls.push('read'); return structuredClone(state); },
    async write(value) { calls.push(['write', value]); state = { exists: true, value, hasChildren: false }; },
    async remove(expected) { calls.push(['remove', expected]); assert.equal(state.value, expected); state = { exists: false }; }
  };
}
const receipt = result => ({ schemaVersion: 1, registrationRevision: REGISTRATION_REVISION, installerVersion: INSTALLER_VERSION, registeredAt: '2026-10-04T12:00:00.000Z', platform: result.platform, manifestPath: result.manifestPath, registrationPath: result.registrationPath });

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
  for (const state of [{ exists: true, value: join(f.root, 'other.json') }, { exists: true, value: '' }, { exists: true, value: f.manifestPath, hasChildren: true }]) {
    const foreign = registry(state);
    await assert.rejects(registerNativeHost({ ...f, platform: 'win', registryAdapter: foreign }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    await assert.rejects(unregisterNativeHost({ ...f, platform: 'win', registryAdapter: foreign }), { code: 'NATIVE_REGISTRATION_CONFLICT' });
    assert.ok(foreign.calls.every(call => call === 'read'));
    assert.deepEqual(foreign.state(), state);
  }
  const lostWrite = registry(); lostWrite.write = async () => {};
  await assert.rejects(registerNativeHost({ ...f, platform: 'win', registryAdapter: lostWrite }), { code: 'NATIVE_REGISTRATION_FAILED' });
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
