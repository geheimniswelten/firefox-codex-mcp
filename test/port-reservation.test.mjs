import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, link, rename, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { managePortReservation } from '../server/port-reservation.mjs';
import { prepareSetup } from '../scripts/setup.mjs';
import { main as ports } from '../scripts/ports.mjs';

test('Windows adapter uses a bounded hidden helper, transports only validated options and propagates structured failures', async () => {
  const result = await managePortReservation('check', { platform: 'win32', port: 38477, run: async (command, args, options) => {
    assert.match(command, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/u);
    assert.equal(options.windowsHide, true); assert.equal(options.timeout, 30_000);
    assert.ok(!Object.keys(options.env).some(key => key.toLowerCase() === 'psmodulepath'));
    assert.deepEqual(JSON.parse(Buffer.from(args.at(-1), 'base64')), { action: 'check', port: 38477 });
    return { stdout: JSON.stringify({ supported: true, exists: false, ownPorts: [] }) };
  } });
  assert.equal(result.exists, false);
  await assert.rejects(managePortReservation('reserve', { platform: 'win32', run: async () => { throw { stdout: '{"error":{"code":"PORT_RESERVED","message":"conflict"}}' }; } }), { code: 'PORT_RESERVED' });
  await assert.rejects(managePortReservation('check', { platform: 'win32', run: async () => ({ stdout: 'broken' }) }), { code: 'PORT_RESERVATION_FAILED' });
  await assert.rejects(managePortReservation('unknown'));
  await assert.rejects(managePortReservation('reserve', { port: 80 }));
  await assert.rejects(managePortReservation('check', { directory: 'relative' }));
  assert.equal((await managePortReservation('check', { platform: 'linux' })).supported, false);
  await assert.rejects(managePortReservation('reserve', { platform: 'linux' }), /Windows/u);
});

test('port CLI rejects ambiguous releases and invalid inputs before executing a transaction', async () => {
  const manage = async () => { throw new Error('must not run'); };
  for (const args of [['release'], ['reserve', '--port', '80'], ['reserve', '--port', '38477x'], ['reserve', '--root', 'relative'], ['bad-action'], ['reserve', '--bad']]) await assert.rejects(ports(args, { manage }));
});

test('setup checks/reserves the selected port before writing a config and retains old config on conflict', async t => {
  const root = await mkdtemp(join(tmpdir(), 'firefox-ports-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const portManager = async (action, options) => { calls.push({ action, ...options }); return { ownPorts: [] }; };
  const first = await prepareSetup({ root, platform: 'win32', port: 43871, reservePort: true, portManager });
  assert.deepEqual(calls[0], { action: 'reserve', port: 43871, platform: 'win32' });
  const config = await readFile(first.configPath, 'utf8');
  await assert.rejects(prepareSetup({ root, port: 43872, portManager: async (action, options) => {
    assert.equal(action, 'prepare'); assert.equal(options.port, 43872);
    throw Object.assign(new Error('foreign reservation'), { code: 'PORT_RESERVED' });
  } }), { code: 'PORT_RESERVED' });
  assert.equal(await readFile(first.configPath, 'utf8'), config);
});

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'firefox-port-reservation-'));
  t.after(async () => {
    // The shared directory deliberately grants no DELETE_CHILD/delete to AU.
    // Restore access ONLY to this synthetic fixture before removing it.
    const code = '$ErrorActionPreference="Stop"; $path=$env:FIREFOX_MCP_TEST_PORT_DIR; if([IO.Directory]::Exists($path)){ $acl=[IO.Directory]::GetAccessControl($path); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow")); [IO.Directory]::SetAccessControl($path,$acl) }';
    const env = { ...process.env, PSModulePath: '', FIREFOX_MCP_TEST_PORT_DIR: join(parent, 'shared') };
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { env, windowsHide: true, timeout: 15_000 });
    await rm(parent, { recursive: true, force: true });
  });
  const directory = join(parent, 'shared');
  return { parent, directory, call: (action, options = {}) => managePortReservation(action, { directory, ...options }) };
}
const windows = { skip: process.platform !== 'win32', timeout: 120_000 };
async function fileSecurity(path) {
  const code = '$acl=Get-Acl -LiteralPath $env:FIREFOX_MCP_TEST_PORT_FILE; @{owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)} | ConvertTo-Json -Compress';
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { env: { ...process.env, PSModulePath: '', FIREFOX_MCP_TEST_PORT_FILE: path }, windowsHide: true, timeout: 15_000 });
  const security = JSON.parse(result.stdout);
  // SetSecurityInfo may set informational SE_DACL_AUTO_INHERITED even for a
  // protected DACL. Compare owner, actual ACEs and protection, not that marker.
  security.dacl = security.dacl.replace(/^(D:[^()]*)AI(?=\()/u, '$1');
  return security;
}

test('Windows transactions share DAI files, preserve foreign lines/BOM and retain reservations across changes', windows, async t => {
  const f = await fixture(t);
  assert.equal((await f.call('status')).exists, false);
  await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
  await f.call('init');
  const first = await f.call('suggest');
  await f.call('reserve', { port: first.port });
  const ownName = (await readdir(f.directory)).find(name => !name.startsWith('.'));
  const own = join(f.directory, ownName);
  const originalSecurity = await fileSecurity(own);
  assert.equal(originalSecurity.owner, ownName.split('_')[0], 'new files explicitly belong to the token user, including elevated setup');
  const prefix = '\uFEFF# DAI and future apps\r\n7331\tDAI:dai\r\n17331\tDAI:dai_bds37_0\n# keep me\r\n';
  await writeFile(own, prefix + `${first.port}\tFirefoxMCP:http\r\n`);
  await assert.rejects(f.call('check', { port: 7331 }), { code: 'PORT_RESERVED' });
  const second = await f.call('suggest');
  await f.call('prepare', { port: second.port });
  assert.equal(await readFile(own, 'utf8'), prefix + `${first.port}\tFirefoxMCP:http\r\n${second.port}\tFirefoxMCP:http\r\n`);
  assert.deepEqual((await f.call('status')).ownPorts, [first.port, second.port].sort((a, b) => a - b));
  await f.call('release', { port: first.port });
  assert.equal(await readFile(own, 'utf8'), prefix + `${second.port}\tFirefoxMCP:http\r\n`);
  assert.deepEqual(await fileSecurity(own), originalSecurity, 'atomic replacements preserve owner, ACEs and DACL protection');
  const unchanged = await readFile(own);
  assert.equal((await f.call('release', { port: 7331 })).changed, false);
  assert.deepEqual(await readFile(own), unchanged);
  assert.equal((await f.call('reserve', { port: second.port })).changed, false);
  const renamed = join(f.directory, ownName.split('_')[0] + '_PreviousAccountName');
  await rename(own, renamed);
  assert.deepEqual((await f.call('status')).ownPorts, [second.port], 'SID, not the account name, identifies the user file');
  assert.ok((await readdir(f.directory)).every(name => !name.startsWith('.tmp-')));
});

test('Windows inventory fails closed on corruption, duplicate SIDs/ports, links and unrecognized user files', windows, async t => {
  const f = await fixture(t); await f.call('init');
  const foreign = join(f.directory, 'S-1-5-21-111-222-333-1001_Another');
  await writeFile(foreign, '# user file\n40001\tOther:http\n');
  await assert.rejects(f.call('reserve', { port: 40001 }), { code: 'PORT_RESERVED' });
  assert.equal(await readFile(foreign, 'utf8'), '# user file\n40001\tOther:http\n');
  for (const invalid of ['bad port\n', '80\tOther:http\tbad\n', '40001\tOther:http\n40001\tOther:second\n', '65536\tOther:http\n']) {
    await writeFile(foreign, invalid);
    await assert.rejects(f.call('reserve'), error => ['INVALID_PORT_FILE', 'DUPLICATE_PORT'].includes(error.code));
    assert.equal(await readFile(foreign, 'utf8'), invalid);
  }
  await writeFile(foreign, '40001\tOther:http\n');
  const duplicate = join(f.directory, 'S-1-5-21-111-222-333-1001_Renamed');
  await writeFile(duplicate, '# duplicate SID\n');
  await assert.rejects(f.call('check'), { code: 'DUPLICATE_PORT_USER' });
  await rm(duplicate);
  const hardlink = join(f.parent, 'hardlink'); await link(foreign, hardlink);
  await assert.rejects(f.call('check'), { code: 'UNSAFE_PORT_FILE' });
  await rm(hardlink);
  await writeFile(join(f.directory, 'unexpected'), '40002\tOther:http\n');
  await assert.rejects(f.call('check'), { code: 'INVALID_PORT_FILE' });
});

test('Windows global mutex serializes competing reservations and never silently selects another port', windows, async t => {
  const f = await fixture(t); await f.call('init');
  const { port } = await f.call('suggest');
  const results = await Promise.all([f.call('reserve', { port }), f.call('reserve', { port })]);
  assert.equal(results.filter(result => result.changed).length, 1);
  assert.deepEqual((await f.call('status')).ownPorts, [port]);
  const own = join(f.directory, (await readdir(f.directory)).find(name => !name.startsWith('.')));
  assert.equal((await readFile(own, 'utf8')).split(`\tFirefoxMCP:http`).length - 1, 1);
});

test('Windows rejects reparse-point directories before modifying the shared inventory', windows, async t => {
  const f = await fixture(t); await f.call('init');
  const alias = join(f.parent, 'alias'); await symlink(f.directory, alias, 'junction');
  try {
    await assert.rejects(f.call('reserve', { directory: alias }), { code: 'UNSAFE_PORT_PATH' });
    assert.deepEqual((await f.call('status')).ownPorts, []);
  } finally { await unlink(alias); }
});

test('Windows exclusive bind test rejects occupied listeners; existing reservations survive listener conflicts', windows, async t => {
  const f = await fixture(t); await f.call('init');
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  await assert.rejects(f.call('reserve', { port }), { code: 'PORT_IN_USE' });
  assert.deepEqual((await f.call('status')).ownPorts, []);
  // Ownership of an existing reservation is persistent, independent of sockets.
  const ownName = 'S-1-5-21-111-222-333-1001_Existing';
  await writeFile(join(f.directory, ownName), `${port}\tOther:http\n`);
  await assert.rejects(f.call('check', { port }), { code: 'PORT_RESERVED' });
});
