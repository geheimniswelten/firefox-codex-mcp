import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { assertRegistrationCompatible, prepareSetup, unregisterSetup, main, tomlLiteral } from '../scripts/setup.mjs';
import { HOST_NAME, REGISTRATION_REVISION, INSTALLER_VERSION, readRegistrationStatus, registrationStatusPath } from '../scripts/registration.mjs';

async function cleanupTemporaryRoot(root) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('firefox-mcp-'));
  await rm(root, { recursive: true, force: true });
}

test('setup erzeugt private Dateien ohne Registrierung und behält Token/Port', async t => {
  const root = await mkdtemp(join(tmpdir(), 'firefox-mcp-setup-'));
  t.after(() => cleanupTemporaryRoot(root));
  const first = await prepareSetup({ root, port: 42345 });
  const config = JSON.parse(await readFile(first.configPath, 'utf8'));
  assert.equal(first.registered, false);
  assert.equal(config.port, 42345);
  assert.match(config.token, /^[a-f0-9]{64}$/u);
  const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8'));
  assert.equal(manifest.name, 'de.codex.firefox_bridge');
  assert.deepEqual(manifest.allowed_extensions, ['firefox-codex-mcp@local.invalid']);
  assert.equal(manifest.path, first.launcherPath);
  const toml = await readFile(first.codexPath, 'utf8');
  assert.ok(toml.includes(tomlLiteral(process.execPath)));
  assert.ok(toml.includes(tomlLiteral(first.configPath)));
  assert.ok(!toml.includes(config.token));
  const again = await prepareSetup({ root });
  assert.deepEqual(JSON.parse(await readFile(again.configPath, 'utf8')), config);
  await prepareSetup({ root, port: 42346 });
  assert.deepEqual(JSON.parse(await readFile(first.configPath, 'utf8')), { ...config, port: 42346 });
});

test('ungültige vorhandene Konfiguration wird nicht ersetzt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'firefox-mcp-invalid-'));
  t.after(() => cleanupTemporaryRoot(root));
  const prepared = await prepareSetup({ root });
  const invalid = '{"port":12,"token":"invalid"}';
  await writeFile(prepared.configPath, invalid);
  await assert.rejects(prepareSetup({ root }), /ungültig/u);
  assert.equal(await readFile(prepared.configPath, 'utf8'), invalid);
});

test('Port, TOML-Literal und fremde Registrierung werden geprüft', async () => {
  await assert.rejects(prepareSetup({ port: 80 }), /Port/u);
  assert.equal(tomlLiteral('C:\\Tools\\node.exe'), "'C:\\Tools\\node.exe'");
  assert.equal(tomlLiteral("C:\\O'Brien\\node.exe"), "'''C:\\O'Brien\\node.exe'''");
  assert.throws(() => tomlLiteral('bad\npath'), /Zeichen/u);
  assert.throws(() => tomlLiteral("three'''quotes"), /Apostrophe/u);
  assert.doesNotThrow(() => assertRegistrationCompatible(undefined, '/project/host.json'));
  assert.doesNotThrow(() => assertRegistrationCompatible('/project/host.json', '/project/host.json'));
  assert.throws(() => assertRegistrationCompatible('/other/host.json', '/project/host.json'), /anders registriert/u);
  assert.throws(() => assertRegistrationCompatible(null, '/project/host.json'), /gültigen Manifestpfad/u);
});

function registryAdapter() {
  let value;
  return {
    async read() { return value === undefined ? { exists: false } : { exists: true, value }; },
    async write(path) { value = path; },
    async remove(path) { assert.equal(value, path); value = undefined; }
  };
}

test('setup records registration only after success and generation leaves an earlier receipt unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'firefox-mcp-registration-setup-'));
  t.after(() => cleanupTemporaryRoot(root));
  const adapter = registryAdapter();
  const generated = await prepareSetup({ root });
  assert.equal(generated.registrationStatus, null);
  assert.equal(await readRegistrationStatus(generated.configPath), null);
  const registered = await prepareSetup({ root, register: true, platform: 'win', registryAdapter: adapter, now: () => Date.UTC(2026, 9, 4, 12) });
  assert.equal(registered.registered, true);
  assert.equal(registered.registrationPath, `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`);
  assert.deepEqual(await readRegistrationStatus(registered.configPath), {
    schemaVersion: 1, registrationRevision: REGISTRATION_REVISION, installerVersion: INSTALLER_VERSION,
    registeredAt: '2026-10-04T12:00:00.000Z', platform: 'win', manifestPath: registered.manifestPath, registrationPath: registered.registrationPath
  });
  const original = await readFile(registrationStatusPath(registered.configPath), 'utf8');
  await prepareSetup({ root, register: false, now: () => Date.UTC(2026, 9, 8) });
  assert.equal(await readFile(registrationStatusPath(registered.configPath), 'utf8'), original);
  adapter.write = async () => { throw new Error('must not overwrite an existing registration'); };
  const reused = await prepareSetup({ root, register: true, platform: 'win', registryAdapter: adapter, now: () => Date.UTC(2026, 9, 5) });
  assert.equal(reused.registrationStatus.registeredAt, '2026-10-05T00:00:00.000Z');
});

test('failed or unconfirmed native registration never creates a successful registration receipt', async t => {
  for (const failure of ['write', 'readback']) {
    const root = await mkdtemp(join(tmpdir(), 'firefox-mcp-failed-registration-'));
    t.after(() => cleanupTemporaryRoot(root));
    const adapter = registryAdapter();
    adapter.write = failure === 'write' ? async () => { throw new Error('registration failed'); } : async () => {};
    await assert.rejects(prepareSetup({ root, register: true, platform: 'win', registryAdapter: adapter }));
    const configPath = join(root, '.local', 'config.json');
    assert.equal(await readRegistrationStatus(configPath), null);
    await assert.rejects(readFile(registrationStatusPath(configPath)), { code: 'ENOENT' });
  }
});

test('native deregistration previews and removes its receipt without deleting generated project files or creating a missing install', async t => {
  const root = await mkdtemp(join(tmpdir(), 'firefox-mcp-unregister-setup-'));
  t.after(() => cleanupTemporaryRoot(root));
  const adapter = registryAdapter();
  const prepared = await prepareSetup({ root, register: true, platform: 'win', registryAdapter: adapter });
  const config = await readFile(prepared.configPath, 'utf8');
  const before = await readFile(registrationStatusPath(prepared.configPath), 'utf8');
  const preview = await unregisterSetup({ root, platform: 'win', registryAdapter: adapter, dryRun: true });
  assert.equal(preview.changed, true); assert.equal(preview.statusRemoved, true);
  assert.equal(await readFile(registrationStatusPath(prepared.configPath), 'utf8'), before);
  const result = await unregisterSetup({ root, platform: 'win', registryAdapter: adapter });
  assert.equal(result.changed, true);
  assert.equal(await readRegistrationStatus(prepared.configPath), null);
  assert.equal(await readFile(prepared.configPath, 'utf8'), config);
  assert.ok((await readFile(prepared.manifestPath, 'utf8')).includes(HOST_NAME));
  const missing = join(root, 'nonexistent');
  const empty = await unregisterSetup({ root: missing, platform: 'win', registryAdapter: registryAdapter() });
  assert.equal(empty.changed, false);
  await assert.rejects(readFile(join(missing, '.local', 'config.json')), { code: 'ENOENT' });
});

test('CLI rejects conflicting native operations and unsupported dry-run before doing setup work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'firefox-mcp-cli-registration-'));
  t.after(() => cleanupTemporaryRoot(root));
  for (const args of [['--register-native', '--unregister-native'], ['--unregister-native', '--port', '38477'], ['--dry-run']]) {
    await assert.rejects(main(['--root', root, ...args]));
    await assert.rejects(readFile(join(root, '.local', 'config.json')), { code: 'ENOENT' });
  }
});
