import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));

async function fixture(t, { commandNpm = false, failure = '' } = {}) {
  const temporary = resolve(tmpdir()), root = await mkdtemp(join(temporary, 'firefox-build-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), temporary);
    assert.match(basename(root), /^firefox-build-/);
    await rm(root, { recursive: true, force: true });
  });
  const repo = join(root, "repo O'Brien with spaces"), log = join(root, 'calls.jsonl');
  await mkdir(join(repo, 'scripts'), { recursive: true });
  await mkdir(join(repo, 'node_modules', 'web-ext', 'bin'), { recursive: true });
  await copyFile(join(project, 'build.ps1'), join(repo, 'build.ps1'));
  await writeFile(join(repo, 'record.mjs'), `import {appendFileSync} from 'node:fs';
export function record(phase) {
  appendFileSync(process.env.FIREFOX_BUILD_LOG,JSON.stringify({phase,cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');
  if(process.env.FIREFOX_BUILD_FAILURE===phase)process.exit(7);
}`);
  await writeFile(join(repo, 'npm-cli.mjs'), "import {record} from './record.mjs';record('npm');");
  await writeFile(join(repo, 'scripts', 'check.mjs'), "import {record} from '../record.mjs';record('check');");
  await writeFile(join(repo, 'scripts', 'package.mjs'), "import {record} from '../record.mjs';record('package');");
  await writeFile(join(repo, 'node_modules', 'web-ext', 'bin', 'web-ext.js'), "import {record} from '../../../record.mjs';record('lint');");
  await writeFile(join(repo, 'scripts', 'npm.cmd'), '@echo off\r\n"%FIREFOX_BUILD_NODE%" "%~dp0..\\npm-cli.mjs" %*\r\nexit /b %errorlevel%\r\n');
  await writeFile(join(repo, 'scripts', 'node-runtime.ps1'), `function Resolve-FirefoxNodeRuntime {
    param([string]$ProjectRoot, [switch]$NoDownload)
    if (-not $NoDownload) { throw 'The fixture requires -NoDownload.' }
    return [pscustomobject]@{
      NodePath = $env:FIREFOX_BUILD_NODE
      NpmCliPath = ${commandNpm ? '$null' : "(Join-Path $ProjectRoot 'npm-cli.mjs')"}
      NpmCommandPath = ${commandNpm ? "(Join-Path $ProjectRoot 'scripts\\npm.cmd')" : '$null'}
    }
  }`);
  return {
    repo,
    async run(skip = false) {
      const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `$beforeLocation = (Get-Location).Path; $beforePath = $env:PATH; & $env:FIREFOX_BUILD_SCRIPT -NoDownload${skip ? ' -SkipDependencies' : ''}; if ((Get-Location).Path -ne $beforeLocation -or $env:PATH -ne $beforePath) { exit 9 }; exit $LASTEXITCODE`], {
        cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true,
        env: { ...cleanEnv, FIREFOX_BUILD_SCRIPT: join(repo, 'build.ps1'), FIREFOX_BUILD_NODE: process.execPath, FIREFOX_BUILD_LOG: log, FIREFOX_BUILD_FAILURE: failure },
      });
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
      return { ...result, calls };
    },
  };
}

test('Windows build uses locked dev dependencies, the repository directory and all validation steps', { skip: !windows }, async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.deepEqual(result.calls.map(call => call.phase), ['npm', 'check', 'package', 'lint']);
  assert.deepEqual(result.calls[0].args, ['ci', '--include=dev']);
  assert.deepEqual(result.calls.at(-1).args, ['lint', '--source-dir', 'extension']);
  assert.ok(result.calls.every(call => call.cwd === f.repo));
  assert.match(result.stdout, /firefox-codex-mcp-extension\.zip/);
  assert.match(result.stdout, /firefox-codex-mcp-source\.zip/);
});

test('Windows build also supports an npm.cmd runtime', { skip: !windows }, async t => {
  const f = await fixture(t, { commandNpm: true }), result = await f.run();
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.deepEqual(result.calls[0].args, ['ci', '--include=dev']);
});

test('SkipDependencies retains syntax, package and lint checks', { skip: !windows }, async t => {
  const f = await fixture(t), result = await f.run(true);
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.deepEqual(result.calls.map(call => call.phase), ['check', 'package', 'lint']);
});

for (const phase of ['npm', 'check', 'package', 'lint']) {
  test(`Windows build reports ${phase} failures and never starts later steps`, { skip: !windows }, async t => {
    const f = await fixture(t, { failure: phase }), result = await f.run();
    assert.equal(result.status, 1, result.error?.message || result.stderr || result.stdout);
    const phases = ['npm', 'check', 'package', 'lint'];
    assert.deepEqual(result.calls.map(call => call.phase), phases.slice(0, phases.indexOf(phase) + 1));
    assert.match(result.stdout, /Build fehlgeschlagen/);
    assert.doesNotMatch(result.stdout, /Build fertig:/);
  });
}
