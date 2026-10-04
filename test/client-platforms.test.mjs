import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClients, configureClients } from '../scripts/client-config.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(project, 'work', 'client-platform-tests');
async function fixture(t) {
  await mkdir(base, { recursive: true });
  const home = await mkdtemp(join(base, 'isolated-'));
  t.after(async () => {
    const child = relative(base, home);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(home, { recursive: true, force: true });
  });
  return { home, root: join(home, 'installation'), nodePath: process.execPath, env: {} };
}
const byId = (clients, id) => clients.find(client => client.id === id);

test('Windows discovery preserves default AppData, environment paths and explicit overrides', async t => {
  const options = await fixture(t);
  const defaults = await detectClients({ ...options, platform: 'win32' });
  assert.equal(byId(defaults, 'claude-desktop').path, join(options.home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  assert.equal(byId(defaults, 'hermes').path, join(options.home, 'AppData', 'Local', 'hermes', 'config.yaml'));
  const env = { APPDATA: join(options.home, 'roaming'), LOCALAPPDATA: join(options.home, 'local'), XDG_CONFIG_HOME: join(options.home, 'unused-config'), XDG_DATA_HOME: join(options.home, 'unused-data') };
  const overridden = await detectClients({ ...options, platform: 'win32', env });
  assert.equal(byId(overridden, 'claude-desktop').path, join(env.APPDATA, 'Claude', 'claude_desktop_config.json'));
  assert.equal(byId(overridden, 'hermes').path, join(env.LOCALAPPDATA, 'hermes', 'config.yaml'));
  const explicit = await detectClients({ ...options, platform: 'win', env, appData: join(options.home, 'explicit-app'), localAppData: join(options.home, 'explicit-local') });
  assert.equal(byId(explicit, 'claude-desktop').path, join(options.home, 'explicit-app', 'Claude', 'claude_desktop_config.json'));
  assert.equal(byId(explicit, 'hermes').path, join(options.home, 'explicit-local', 'hermes', 'config.yaml'));
});

test('macOS Claude Desktop uses Application Support and Unix Hermes has one unambiguous default', async t => {
  const options = await fixture(t), claude = join(options.home, 'Library', 'Application Support', 'Claude');
  await mkdir(claude, { recursive: true }); await mkdir(join(options.home, '.hermes'));
  const env = { APPDATA: join(options.home, 'windows-roaming'), LOCALAPPDATA: join(options.home, 'windows-local'), XDG_CONFIG_HOME: join(options.home, 'xdg-config'), XDG_DATA_HOME: join(options.home, 'xdg-data') };
  const clients = await detectClients({ ...options, platform: 'darwin', env });
  assert.equal(byId(clients, 'claude-desktop').path, join(claude, 'claude_desktop_config.json'));
  assert.equal(byId(clients, 'claude-desktop').detected, true);
  assert.equal(byId(clients, 'hermes').path, join(options.home, '.hermes', 'config.yaml'));
  assert.equal(byId(clients, 'hermes').detected, true);
  assert.equal(byId(clients, 'hermes').skip, undefined, 'the default and legacy .hermes folder are the same candidate');
});

test('Linux uses the XDG configuration directory instead of Windows AppData and keeps Hermes in its Unix home', async t => {
  const options = await fixture(t);
  const defaults = await detectClients({ ...options, platform: 'linux' });
  assert.equal(byId(defaults, 'claude-desktop').path, join(options.home, '.config', 'Claude', 'claude_desktop_config.json'));
  assert.equal(byId(defaults, 'hermes').path, join(options.home, '.hermes', 'config.yaml'));
  const env = { XDG_CONFIG_HOME: join(options.home, 'custom-config'), XDG_DATA_HOME: join(options.home, 'custom-data'), APPDATA: join(options.home, 'windows-roaming'), LOCALAPPDATA: join(options.home, 'windows-local') };
  await mkdir(join(env.XDG_CONFIG_HOME, 'Claude'), { recursive: true });
  await mkdir(join(env.XDG_DATA_HOME, 'hermes'), { recursive: true });
  await mkdir(join(options.home, '.hermes'));
  const clients = await detectClients({ ...options, platform: 'linux', env });
  assert.equal(byId(clients, 'claude-desktop').path, join(env.XDG_CONFIG_HOME, 'Claude', 'claude_desktop_config.json'));
  assert.equal(byId(clients, 'claude-desktop').detected, true);
  assert.equal(byId(clients, 'hermes').path, join(options.home, '.hermes', 'config.yaml'));
  assert.equal(byId(clients, 'hermes').skip, undefined);
  const relativeXdg = await detectClients({ ...options, platform: 'linux', env: { XDG_CONFIG_HOME: 'relative/config', XDG_DATA_HOME: 'relative/data' } });
  assert.equal(byId(relativeXdg, 'claude-desktop').path, join(options.home, '.config', 'Claude', 'claude_desktop_config.json'));
});

test('explicit client profile variables keep precedence on both Unix platforms', async t => {
  for (const platform of ['linux', 'mac']) {
    const options = await fixture(t), profile = join(options.home, 'profile');
    await mkdir(profile); await mkdir(join(profile, '.gemini'));
    const env = { CODEX_HOME: profile, CLAUDE_CONFIG_DIR: profile, GEMINI_CLI_HOME: profile, HERMES_HOME: profile, OPENCLAW_CONFIG_PATH: join(profile, 'openclaw-custom.json') };
    const clients = await detectClients({ ...options, platform, env });
    assert.equal(byId(clients, 'codex').path, join(profile, 'config.toml'));
    assert.equal(byId(clients, 'claude-code').path, join(profile, '.claude.json'));
    assert.equal(byId(clients, 'gemini').path, join(profile, '.gemini', 'settings.json'));
    assert.equal(byId(clients, 'hermes').path, join(profile, 'config.yaml'));
    assert.equal(byId(clients, 'hermes').skip, undefined);
    assert.equal(byId(clients, 'openclaw').path, join(profile, 'openclaw-custom.json'));
  }
});

test('Windows still refuses ambiguous modern and legacy Hermes folders unless the user chooses a profile', async t => {
  const options = await fixture(t);
  await mkdir(join(options.home, 'AppData', 'Local', 'hermes'), { recursive: true });
  await mkdir(join(options.home, '.hermes'));
  assert.match(byId(await detectClients({ ...options, platform: 'win32' }), 'hermes').skip, /Mehrere Hermes/);
  const selected = await detectClients({ ...options, platform: 'win32', env: { HERMES_HOME: join(options.home, '.hermes') } });
  assert.equal(byId(selected, 'hermes').skip, undefined);
});

test('configureClients forwards the platform and leaves unknown client directories uncreated', async t => {
  const options = await fixture(t);
  const before = await readdir(options.home);
  for (const platform of ['linux', 'darwin']) {
    const absent = await configureClients({ ...options, platform, dryRun: true });
    assert.ok(absent.every(client => client.status === 'not_detected'));
    assert.deepEqual(await readdir(options.home), before);
  }
  await mkdir(join(options.home, 'Library', 'Application Support', 'Claude'), { recursive: true });
  await mkdir(join(options.home, '.hermes'));
  const planned = await configureClients({ ...options, platform: 'darwin', dryRun: true });
  assert.equal(byId(planned, 'claude-desktop').status, 'dry_run');
  assert.equal(byId(planned, 'hermes').status, 'dry_run');
  assert.deepEqual(await readdir(join(options.home, '.hermes')), []);
  const windows = await configureClients({ ...options, platform: 'win32', dryRun: true });
  assert.equal(byId(windows, 'claude-desktop').status, 'not_detected');
});
