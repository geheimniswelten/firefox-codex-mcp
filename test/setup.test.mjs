import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { assertRegistrationCompatible, prepareSetup, tomlLiteral } from '../scripts/setup.mjs';

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
