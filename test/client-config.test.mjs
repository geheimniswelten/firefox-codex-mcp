import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, symlink, link, chmod, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { mergeConfigText, detectClients, configureClients } from '../scripts/client-config.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureBase = join(project, 'work', 'client-config-tests');
const root = join(project, 'work', 'example installation');
const nodePath = process.execPath;
const entry = { command: nodePath, args: [join(root, 'server', 'mcp.mjs'), '--config', join(root, '.local', 'config.json')] };

async function fixture(t) {
  await mkdir(fixtureBase, { recursive: true });
  const home = await mkdtemp(join(fixtureBase, 'isolated-'));
  t.after(async () => {
    const child = relative(fixtureBase, home);
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child));
    await rm(home, { recursive: true, force: true });
  });
  return { root, nodePath, home, appData: join(home, 'roaming'), localAppData: join(home, 'local'), env: {} };
}
const merge = (text, options = {}) => mergeConfigText({ text, entry, ...options });

test('JSONC insertion preserves unrelated bytes, comments and unusual quoted keys', () => {
  const text = '{\r\n  // user comment\r\n  "other": {"secret": "keep me"},\r\n  "mcpServers": {\r\n    /* provider comment */ "weather": {"command":"weather"}\r\n  },\r\n  "tail": 17\r\n}\r\n';
  const configured = merge(text, { format: 'jsonc' });
  assert.equal(configured.status, 'configured', configured.message);
  assert.ok(configured.text.includes('  // user comment\r\n  "other": {"secret": "keep me"},'));
  assert.ok(configured.text.includes('/* provider comment */ "weather": {"command":"weather"}'));
  assert.ok(configured.text.endsWith('  },\r\n  "tail": 17\r\n}\r\n'));
  assert.equal(merge(configured.text, { format: 'jsonc' }).status, 'unchanged');
  const removed = merge(configured.text, { format: 'jsonc', remove: true });
  assert.equal(removed.status, 'removed');
  assert.ok(removed.text.includes('/* provider comment */ "weather": {"command":"weather"}'));
  assert.ok(!removed.text.includes(entry.command.replaceAll('\\', '\\\\')));
});

test('JSON5 nested MCP path supports comments, single quotes, trailing commas and literal numbers', () => {
  const text = "// prefix\n{unrelated: [0x10, -3, +2, 'value'], mcp: { other: true, servers: { service: {command: 'old'}, }, },} // suffix\n";
  const configured = merge(text, { format: 'json5', keys: ['mcp', 'servers'] });
  assert.equal(configured.status, 'configured', configured.message);
  assert.ok(configured.text.includes("unrelated: [0x10, -3, +2, 'value']"));
  assert.ok(configured.text.endsWith(' // suffix\n'));
  assert.equal(merge(configured.text, { format: 'json5', keys: ['mcp', 'servers'] }).status, 'unchanged');
  assert.equal(merge(configured.text, { format: 'json5', keys: ['mcp', 'servers'], remove: true }).status, 'removed');
});

test('missing JSON trees and empty/comment-only configurations create valid minimal JSON', () => {
  for (const text of ['', '{}', '{"other":17}', '{"mcp":{}}', '{"mcp":{"servers":{}}}']) {
    const result = merge(text, { keys: ['mcp', 'servers'] });
    assert.equal(result.status, 'configured', result.message);
    const parsed = JSON.parse(result.text);
    assert.deepEqual(parsed.mcp.servers.firefox, entry);
    if (text.includes('other')) assert.equal(parsed.other, 17);
  }
  assert.equal(merge('// preserve comment\n', { format: 'jsonc' }).status, 'configured');
  assert.equal(merge('\uFEFF{}').text.charCodeAt(0), 0xfeff);
});

test('removing first, middle, last and only JSON server preserves other values', () => {
  for (const servers of [{ firefox: entry }, { firefox: entry, a: 1 }, { a: 1, firefox: entry }, { a: 1, firefox: entry, b: 2 }]) {
    const result = merge(JSON.stringify({ mcpServers: servers, tail: true }), { remove: true });
    assert.equal(result.status, 'removed', result.message);
    const expected = { ...servers }; delete expected.firefox;
    assert.deepEqual(JSON.parse(result.text), { mcpServers: expected, tail: true });
  }
});

test('Acorn configuration processing never executes code and rejects ambiguous syntax', () => {
  const cases = [
    '{mcpServers: getConfig()}', '{get mcpServers(){return {}}}', '{mcpServers(){}}',
    '{["mcpServers"]:{}}', '{...globalThis}', '{mcpServers}', '{a:1,a:2}', '{"a":1, a:2}',
    '{a: /value/}', '{a: 1n}', '{a: undefined}', '{a: Infinity}', '{a: [,,]}',
    '{};globalThis.shouldNeverExecute=true', '({})', '[]', 'null', '{mcpServers: []}',
  ];
  for (const text of cases) {
    const result = merge(text, { format: 'json5' });
    assert.equal(result.status, 'conflict', text);
    assert.equal(result.text, text);
  }
  assert.equal(globalThis.shouldNeverExecute, undefined);
  assert.equal(merge('{"__proto__": {"polluted": true}}').status, 'configured');
  assert.equal({}.polluted, undefined);
});

test('foreign or user-modified Firefox entries are preserved on install and uninstall', () => {
  for (const modified of [{ ...entry, args: ['foreign.mjs'] }, { ...entry, disabled: true }, { ...entry, command: 'different-node' }]) {
    const text = JSON.stringify({ mcpServers: { firefox: modified } });
    for (const remove of [false, true]) {
      const result = merge(text, { remove });
      assert.equal(result.status, 'conflict');
      assert.equal(result.text, text);
    }
  }
});

test('strict JSON clients reject JSON5 syntax and redact parse errors', () => {
  for (const text of ['{unquoted:17}', '{"value": 0x12}', '{/* PRIVATE_SECRET */ "ok": true}', '{"PRIVATE_SECRET":']) {
    const result = merge(text);
    assert.equal(result.status, 'conflict');
    assert.equal(result.text, text);
    assert.ok(!result.message.includes('PRIVATE_SECRET'));
  }
});

test('relocated uninstall accepts a different absolute Node runtime but retains exact script/config ownership', () => {
  const previous = { ...entry, command: join(root, '.runtime', 'old-node', 'node.exe') };
  for (const format of ['json', 'json5', 'toml', 'yaml']) {
    const configured = merge('', { format, entry: previous });
    assert.equal(configured.status, 'configured', `${format}: ${configured.message}`);
    assert.equal(merge(configured.text, { format, remove: true }).status, 'removed', format);
    const foreign = { ...entry, args: [join(root, 'other', 'mcp.mjs'), '--config', entry.args[2]] };
    assert.equal(merge(configured.text, { format, entry: foreign, remove: true }).status, 'conflict', format);
  }
});

test('Codex TOML marked blocks round-trip original bytes and detect any managed-body change', () => {
  for (const text of ['', 'model = "example"', 'model = "example"\n', '# keep\r\n[features]\r\nfoo = true\r\n']) {
    const configured = merge(text, { format: 'toml' });
    assert.equal(configured.status, 'configured', configured.message);
    assert.equal(merge(configured.text, { format: 'toml' }).status, 'unchanged');
    assert.equal(merge(configured.text, { format: 'toml', remove: true }).text, text);
    const changed = configured.text.replace('tool_timeout_sec = 180', 'tool_timeout_sec = 181');
    assert.equal(merge(changed, { format: 'toml', remove: true }).status, 'conflict');
  }
  for (const text of ['[mcp_servers.firefox]\ncommand="other"\n', 'mcp_servers = {}\n', 'mcp_servers={weather={command="x"}}', 'key="""hello\n"""\n', 'key = [1,', 'key = "unterminated']) {
    assert.equal(merge(text, { format: 'toml' }).status, 'conflict', text);
  }
  const marked = merge('', { format: 'toml' }).text;
  const stringContainingMarker = `prompt = """\n${marked}"""\n`;
  const result = merge(stringContainingMarker, { format: 'toml', remove: true });
  assert.equal(result.status, 'conflict');
  assert.equal(result.text, stringContainingMarker);
});

// Split only freshly generated fixture blocks to edit marker/separator bytes.
function tomlFixtureParts(text) {
  const begin = text.indexOf('# BEGIN firefox-codex-mcp');
  const body = text.indexOf('\n', begin) + 1;
  const end = text.indexOf('# END firefox-codex-mcp', body);
  return { prefix: text.slice(0, begin), begin: text.slice(begin, body), body: text.slice(body, end), end: text.slice(end) };
}
function assertTomlRoundTrip(text, expected, label) {
  const unchanged = merge(text, { format: 'toml' });
  assert.equal(unchanged.status, 'unchanged', `${label}: ${unchanged.message}`);
  assert.equal(unchanged.text, text, label);
  const removed = merge(text, { format: 'toml', remove: true });
  assert.equal(removed.status, 'removed', `${label}: ${removed.message}`);
  assert.equal(removed.text, expected, label);
}

test('Codex TOML preserves external EOL edits and following foreign tables byte for byte', () => {
  for (const bodyEol of ['\n', '\r\n']) {
    const externalEol = bodyEol === '\n' ? '\r\n' : '\n';
    const original = `# settings${bodyEol}model = "example"${bodyEol}`;
    const configured = merge(original, { format: 'toml' }).text;
    const changedOriginal = `# settings${externalEol}model = "example"${externalEol}`;
    const suffix = '\r\n# leave this table untouched\n[mcp_servers.weather]\r\ncommand = "other"\nargs = ["remote"]\r\n';
    const mixed = changedOriginal + configured.slice(original.length) + suffix;
    assertTomlRoundTrip(mixed, changedOriginal + suffix, JSON.stringify(bodyEol));
  }
});

test('Codex TOML recognizes independently changed BEGIN and END line endings without changing its body', () => {
  for (const bodyEol of ['\n', '\r\n']) {
    const markerEol = bodyEol === '\n' ? '\r\n' : '\n';
    const original = `model = "example"${bodyEol}`;
    const parts = tomlFixtureParts(merge(original, { format: 'toml' }).text);
    for (const marker of ['begin', 'end']) {
      const changed = { ...parts, [marker]: parts[marker].slice(0, -bodyEol.length) + markerEol };
      const text = changed.prefix + changed.begin + changed.body + changed.end;
      assertTomlRoundTrip(text, original, `${marker} ${JSON.stringify(bodyEol)}`);
    }
  }
});

test('Codex TOML END at EOF needs no trailing newline for either managed-body EOL', () => {
  for (const original of ['', 'model = "example"\r\n']) {
    const configured = merge(original, { format: 'toml' }).text;
    const eof = configured.replace(/\r?\n$/u, '');
    assertTomlRoundTrip(eof, original, JSON.stringify(original));
  }
});

test('Codex TOML removes exactly its zero, one or two prefix newlines with mixed separators', () => {
  const suffix = '\n[features]\r\nkeep = true\n';
  for (const [original, separator] of [
    ['', ''],
    ['model = "example"\n', '\r\n'],
    ['model = "example"', '\n\r\n'],
    ['model = "example"', '\r\n\n']
  ]) {
    const parts = tomlFixtureParts(merge(original, { format: 'toml' }).text);
    const mixed = original + separator + parts.begin + parts.body + parts.end + suffix;
    assertTomlRoundTrip(mixed, original + suffix, JSON.stringify([original, separator]));
  }
  const original = 'model = "example"';
  const parts = tomlFixtureParts(merge(original, { format: 'toml' }).text);
  const adjacentSuffix = '[features]\r\nkeep = true\n';
  for (const separator of ['\n\r\n', '\r\n\n']) {
    const mixed = original + separator + parts.begin + parts.body + parts.end + adjacentSuffix;
    const retainedSeparator = separator.startsWith('\r\n') ? '\r\n' : '\n';
    assertTomlRoundTrip(mixed, original + retainedSeparator + adjacentSuffix, `adjacent foreign table ${JSON.stringify(separator)}`);
  }
  const missingSeparator = original + '\r\n' + parts.begin + parts.body + parts.end;
  const rejected = merge(missingSeparator, { format: 'toml', remove: true });
  assert.equal(rejected.status, 'conflict');
  assert.equal(rejected.text, missingSeparator);
});

test('Codex TOML still rejects changed body bytes, foreign ownership and incomplete or ambiguous markers', () => {
  const marked = merge('model = "example"\n', { format: 'toml' }).text;
  const parts = tomlFixtureParts(marked);
  const withBody = body => {
    const prefix = /prefix=([012])/u.exec(parts.begin)[1];
    const hash = createHash('sha256').update(`${prefix}\n${body}`).digest('hex');
    const begin = parts.begin.replace(/sha256=[a-f0-9]{64}/u, `sha256=${hash}`);
    return parts.prefix + begin + body + parts.end;
  };
  const crlf = merge('model = "example"\r\n', { format: 'toml' }).text;
  const crlfParts = tomlFixtureParts(crlf);
  const cases = [
    ['body LF to CRLF with original hash', parts.prefix + parts.begin + parts.body.replaceAll('\n', '\r\n') + parts.end],
    ['body CRLF to LF with original hash', crlfParts.prefix + crlfParts.begin + crlfParts.body.replaceAll('\r\n', '\n') + crlfParts.end],
    ['changed setting even with recomputed hash', withBody(parts.body.replace('tool_timeout_sec = 180', 'tool_timeout_sec = 181'))],
    ['foreign args even with recomputed hash', withBody(parts.body.replace(JSON.stringify(entry.args), JSON.stringify(['foreign.mjs'])))],
    ['modified hash', marked.replace(/sha256=[a-f0-9]{64}/u, `sha256=${'0'.repeat(64)}`)],
    ['missing END', parts.prefix + parts.begin + parts.body],
    ['duplicate END', marked + parts.end],
    ['END marker prefix with suffix', marked.replace('# END firefox-codex-mcp', '# END firefox-codex-mcp-suffix')]
  ];
  for (const [label, text] of cases) {
    for (const remove of [false, true]) {
      const result = merge(text, { format: 'toml', remove });
      assert.equal(result.status, 'conflict', `${label}, remove=${remove}: ${result.message}`);
      assert.equal(result.text, text, label);
    }
  }
});

test('YAML MCP edits preserve all unrelated comments and values', () => {
  const hermesEntry = { ...entry, timeout: 180 };
  for (const text of ['# my settings\nmodel: local\n', '# my settings\nmcp_servers:\n  weather:\n    command: tool\n# keep section\nmodel: local\n']) {
    const configured = merge(text, { format: 'yaml', entry: hermesEntry });
    assert.equal(configured.status, 'configured', configured.message);
    assert.ok(configured.text.includes('# my settings\n'));
    assert.deepEqual(yaml.load(configured.text).mcp_servers.firefox, hermesEntry);
    assert.equal(yaml.load(configured.text).model, 'local');
    assert.equal(merge(configured.text, { format: 'yaml', entry: hermesEntry }).status, 'unchanged');
    const removed = merge(configured.text, { format: 'yaml', entry: hermesEntry, remove: true });
    assert.equal(removed.status, 'removed', removed.message);
    assert.ok(removed.text.includes('# my settings\n'));
    assert.equal(yaml.load(removed.text).model, 'local');
    assert.equal(merge(removed.text, { format: 'yaml', entry: hermesEntry }).status, 'configured');
  }
});

test('unsupported YAML aliases, tags, flow MCP and duplicate keys are preserved', () => {
  for (const text of ['x: &a value\ny: *a\n', 'x: !!js/function function(){}\n', 'mcp_servers: {}\n', 'mcp_servers:\n  x: {}\nmcp_servers:\n  y: {}\n', 'mcp_servers:\n  weather:\n    command: |\n      hello\n']) {
    const result = merge(text, { format: 'yaml' });
    assert.equal(result.status, 'conflict', text);
    assert.equal(result.text, text);
  }
});

test('detection uses isolated existing config markers and never creates unknown client folders', async t => {
  const options = await fixture(t);
  assert.equal((await detectClients(options)).filter(c => c.detected).length, 0);
  await mkdir(join(options.home, '.claude'));
  await mkdir(join(options.home, '.lmstudio'));
  const clients = await detectClients(options);
  assert.deepEqual(clients.filter(c => c.detected).map(c => c.id), ['claude-code', 'lm-studio']);
  const before = await readdir(options.home);
  const results = await configureClients({ ...options, dryRun: true });
  assert.deepEqual(results.filter(c => c.status === 'dry_run').map(c => c.id), ['claude-code', 'lm-studio']);
  assert.deepEqual(await readdir(options.home), before);
  assert.deepEqual(await readdir(join(options.home, '.lmstudio')), []);
});

test('explicit profile overrides are respected and ambiguous/read-only OpenClaw is skipped', async t => {
  const options = await fixture(t);
  const profile = join(options.home, 'profiles');
  await mkdir(profile);
  const env = { CODEX_HOME: profile, CLAUDE_CONFIG_DIR: profile, GEMINI_CLI_HOME: profile, HERMES_HOME: profile, OPENCLAW_CONFIG_PATH: join(profile, 'custom.json') };
  await mkdir(join(profile, '.gemini'));
  const clients = await detectClients({ ...options, env });
  assert.equal(clients.find(c => c.id === 'claude-code').path, join(profile, '.claude.json'));
  assert.equal(clients.find(c => c.id === 'gemini').path, join(profile, '.gemini', 'settings.json'));
  assert.equal(clients.find(c => c.id === 'hermes').path, join(profile, 'config.yaml'));
  assert.equal(clients.find(c => c.id === 'openclaw').path, join(profile, 'custom.json'));
  for (const specific of [{ OPENCLAW_PROFILE: 'work' }, { OPENCLAW_HOME: profile }, { OPENCLAW_CONFIG_READONLY: '1' }, { OPENCLAW_NIX_MODE: '1' }]) {
    const result = await configureClients({ ...options, env: specific, dryRun: true });
    assert.equal(result.find(c => c.id === 'openclaw').status, 'skipped');
  }
  await mkdir(join(options.localAppData, 'hermes'), { recursive: true });
  await mkdir(join(options.home, '.hermes'));
  assert.ok((await detectClients(options)).find(c => c.id === 'hermes').skip);
});

test('symlink/junction config directories and hard-linked files are rejected even during dry run', async t => {
  const options = await fixture(t);
  const outside = join(options.home, 'outside');
  await mkdir(outside);
  await symlink(outside, join(options.home, '.lmstudio'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(options.home, '.eigent'));
  const original = join(outside, 'original.json');
  await writeFile(original, '{}');
  await link(original, join(options.home, '.eigent', 'mcp.json'));
  const results = await configureClients({ ...options, dryRun: true });
  assert.equal(results.find(c => c.id === 'lm-studio').status, 'conflict');
  assert.equal(results.find(c => c.id === 'eigent').status, 'conflict');
  assert.equal(await readFile(original, 'utf8'), '{}');
});

test('Windows ACL restrictions fail closed before writing any configuration contents', { skip: process.platform !== 'win32' }, async t => {
  const options = await fixture(t);
  const folder = join(options.home, '.lmstudio'), path = join(folder, 'mcp.json');
  await mkdir(folder);
  const original = '{"private":"FIXTURE_SECRET_NEVER_LOGGED"}\n';
  await writeFile(path, original, { mode: 0o600 });
  const result = (await configureClients(options)).find(c => c.id === 'lm-studio');
  if (result.status !== 'error' || !result.message.startsWith('Windows-Dateirechte')) {
    assert.equal(result.status, 'configured', result.message);
    t.skip('Windows ACL operations are available; constrained-language failure cannot be reproduced in this environment.');
    return;
  }
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(folder), ['mcp.json']);
  assert.ok(!JSON.stringify(result).includes('FIXTURE_SECRET_NEVER_LOGGED'));
  assert.equal(result.backup, undefined);
});

test('real file registration backs up exact bytes, is idempotent and removes only its own entry', async t => {
  const options = await fixture(t);
  const folder = join(options.home, '.lmstudio'), path = join(folder, 'mcp.json');
  await mkdir(folder);
  const original = '{\n  "user": "KEEP_PRIVATE_FIXTURE",\n  "mcpServers": {"weather": {"command": "other"}}\n}\n';
  await writeFile(path, original, { mode: 0o600 });
  const first = (await configureClients(options)).find(c => c.id === 'lm-studio');
  if (process.platform === 'win32' && first.status === 'error' && first.message.startsWith('Windows-Dateirechte')) {
    t.skip('PowerShell ConstrainedLanguage blocks Windows ACL application; successful Windows file replacement cannot be verified here.');
    return;
  }
  assert.equal(first.status, 'configured', first.message);
  assert.equal(await readFile(first.backup, 'utf8'), original);
  if (process.platform !== 'win32') assert.equal((await lstat(first.backup)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(first).includes('KEEP_PRIVATE_FIXTURE'));
  const after = await readdir(folder);
  assert.equal((await configureClients(options)).find(c => c.id === 'lm-studio').status, 'unchanged');
  assert.deepEqual(await readdir(folder), after);
  const removed = (await configureClients({ ...options, remove: true })).find(c => c.id === 'lm-studio');
  assert.equal(removed.status, 'removed', removed.message);
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(parsed.user, 'KEEP_PRIVATE_FIXTURE');
  assert.deepEqual(parsed.mcpServers, { weather: { command: 'other' } });
});

test('read-only and invalid UTF-8 files are preserved with per-client diagnostics', async t => {
  const options = await fixture(t);
  const folder = join(options.home, '.lmstudio'), path = join(folder, 'mcp.json');
  await mkdir(folder);
  await writeFile(path, Buffer.from([0xff, 0xfe, 0x00]));
  assert.equal((await configureClients({ ...options, dryRun: true })).find(c => c.id === 'lm-studio').status, 'conflict');
  await writeFile(path, '{}');
  await chmod(path, 0o444);
  try { assert.equal((await configureClients({ ...options, dryRun: true })).find(c => c.id === 'lm-studio').status, 'conflict'); }
  finally { await chmod(path, 0o600); }
});
