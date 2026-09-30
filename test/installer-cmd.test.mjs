import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const powershellDirectory = join(system32, 'WindowsPowerShell', 'v1.0');
const resultPrompt = 'Zum Schliessen 0 druecken:';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "firefox-mcp-cmd O'Brien ! "));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('firefox-mcp-cmd '));
    await rm(root, { recursive: true, force: true });
  });
  await copyFile(join(project, 'install.cmd'), join(root, 'install.cmd'));
  // The real CMD and Windows PowerShell run only harmless fixture scripts.
  for (const script of ['install.ps1', 'uninstall.ps1']) {
    await writeFile(join(root, script), `
@{ Script = '${script}'; Arguments = @($args); ScriptRoot = $PSScriptRoot } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'invocation.json') -Encoding UTF8
Write-Output 'FIXTURE_SCRIPT_COMPLETED'
exit [int]$env:FIREFOX_MCP_TEST_EXIT
`, 'utf8');
  }
  return root;
}

function run(t, root, { missingPowerShell = false, exitCode = 0 } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['path', 'psmodulepath'].includes(key.toLowerCase())));
  env.PATH = missingPowerShell ? system32 : `${system32};${powershellDirectory}`;
  env.PSModulePath = 'C:\\invalid-inherited-powershell7-modules';
  env.FIREFOX_MCP_TEST_EXIT = String(exitCode);
  // /V:ON verifies that paths containing ! survive an inherited CMD setting.
  const child = spawn(join(system32, 'cmd.exe'), ['/d', '/v:on', '/s', '/c', `""${join(root, 'install.cmd')}""`], {
    cwd: root, env, windowsVerbatimArguments: true, windowsHide: true,
  });
  let output = '';
  let completed = false;
  let processError;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { processError = error; });
  child.stdin.on('error', () => {});
  const done = new Promise(resolveDone => child.on('close', (code, signal) => {
    completed = true;
    resolveDone({ code, signal, output, error: processError });
  }));
  t.after(async () => {
    if (!completed) child.kill();
    await done;
  });
  return {
    child, done,
    output: () => output,
    async waitFor(text) {
      const deadline = Date.now() + 15_000;
      while (!output.includes(text)) {
        assert.ok(!completed, `CMD exited before ${JSON.stringify(text)}: ${output}`);
        assert.ok(Date.now() < deadline, `CMD did not display ${JSON.stringify(text)}: ${output}`);
        await delay(25);
      }
    },
  };
}

test('CMD menu uses CRLF, safe quoted paths, inline PowerShell and descending choices', async () => {
  const cmd = await readFile(join(project, 'install.cmd'), 'utf8');
  assert.ok(cmd.includes('\r\n'));
  assert.doesNotMatch(cmd, /(?<!\r)\n/);
  assert.match(cmd, /setlocal DisableDelayedExpansion\r\n/);
  assert.match(cmd, /set "PSModulePath="/);
  assert.match(cmd, /choice \/C 12340 \/N \/M/i);
  assert.match(cmd, /\[3\] Add-on im Firefox neu laden/);
  assert.match(cmd, /Ziffer ohne Eingabetaste druecken/);
  const branches = [...cmd.matchAll(/if errorlevel (\d+) goto (\w+)/gi)].map(match => [Number(match[1]), match[2]]);
  assert.deepEqual(branches, [[255, 'choice_error'], [5, 'cancelled'], [4, 'uninstall'], [3, 'reload'], [2, 'generate'], [1, 'install']]);
  assert.match(cmd, /:install\r\npowershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\.ps1"\r\nset "operationExit=%errorlevel%"/);
  assert.match(cmd, /:generate\r\npowershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\.ps1" -GenerateOnly/);
  assert.match(cmd, /:uninstall\r\npowershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall\.ps1"/);
  assert.match(cmd, /:reload\r\npowershell\.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\.ps1" -OpenFirefoxOnly\r\nset "operationExit=%errorlevel%"/);
  assert.match(cmd, /choice \/C 0 \/N \/M "Zum Schliessen 0 druecken: "\r\nexit \/b %operationExit%/);
  assert.doesNotMatch(cmd, /^\s*(?:start|pause)\b|Set-ExecutionPolicy|taskkill|rd \/s|rmdir \/s/im);
});

test('real CMD forwards all operations and ignores queued Enter until explicit closing choice', { skip: !windows, timeout: 30_000 }, async t => {
  const root = await fixture(t);
  for (const operation of [
    { key: '1', script: 'install.ps1', args: [], exitCode: 17 },
    { key: '2', script: 'install.ps1', args: ['-GenerateOnly'], exitCode: 0 },
    { key: '3', script: 'install.ps1', args: ['-OpenFirefoxOnly'], exitCode: 0 },
    { key: '4', script: 'uninstall.ps1', args: [], exitCode: 23 },
  ]) {
    const current = run(t, root, operation);
    await current.waitFor('Auswahl [1/2/3/4/0]:');
    current.child.stdin.write(`${operation.key}\r\n`);
    await current.waitFor(resultPrompt);
    await delay(200);
    assert.equal(current.child.exitCode, null, 'A queued Enter must not close the result window.');
    current.child.stdin.end('0');
    const result = await current.done;
    assert.equal(result.code, operation.exitCode, result.output);
    assert.match(result.output, operation.exitCode === 0 ? /Vorgang erfolgreich abgeschlossen/ : new RegExp(`Vorgang fehlgeschlagen. Fehlercode: ${operation.exitCode}`));
    const invocation = JSON.parse((await readFile(join(root, 'invocation.json'), 'utf8')).replace(/^\uFEFF/, ''));
    assert.deepEqual(invocation, { Script: operation.script, Arguments: operation.args, ScriptRoot: await realpath(root) });
  }
});

test('a missing PowerShell executable stays visible and returns its original error after explicit close', { skip: !windows, timeout: 20_000 }, async t => {
  const root = await fixture(t);
  const current = run(t, root, { missingPowerShell: true });
  await current.waitFor('Auswahl [1/2/3/4/0]:');
  current.child.stdin.write('1\r\n');
  await current.waitFor(resultPrompt);
  await delay(200);
  assert.equal(current.child.exitCode, null);
  assert.match(current.output(), /Vorgang fehlgeschlagen. Fehlercode: 9009/);
  current.child.stdin.end('0');
  const result = await current.done;
  assert.equal(result.code, 9009, result.output);
  await assert.rejects(readFile(join(root, 'invocation.json')), { code: 'ENOENT' });
});

test('menu exit requires no operation and returns success immediately', { skip: !windows, timeout: 20_000 }, async t => {
  const root = await fixture(t);
  const current = run(t, root);
  await current.waitFor('Auswahl [1/2/3/4/0]:');
  current.child.stdin.end('0');
  const result = await current.done;
  assert.equal(result.code, 0, result.output);
  assert.ok(!result.output.includes(resultPrompt));
  await assert.rejects(readFile(join(root, 'invocation.json')), { code: 'ENOENT' });
});
