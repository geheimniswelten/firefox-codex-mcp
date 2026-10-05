// Optional smoke test of the actual Firefox toolbar API and SVG rendering.
// Uses an isolated profile and does not connect to the user's native host.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = randomUUID(), runRoot = join(root, 'work', `activity-firefox-${token}`);
const addon = join(runRoot, 'extension'), profile = join(runRoot, 'profile');
let finish, child, timer, log = '';
const report = new Promise(done => { finish = done; });
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== `/report/${token}`) { response.writeHead(404).end(); return; }
  try {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200).end('ok'); finish(value);
  } catch (error) { response.writeHead(400).end(); finish({ ok: false, error: String(error) }); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${server.address().port}/report/${token}`;
try {
  await mkdir(profile, { recursive: true });
  await cp(join(root, 'extension'), addon, { recursive: true });
  const manifest = JSON.parse(await readFile(join(addon, 'manifest.json'), 'utf8'));
  manifest.browser_specific_settings.gecko.id = `activity-test-${token}@local.invalid`;
  manifest.background.scripts = ['test-runner.js'];
  await writeFile(join(addon, 'manifest.json'), JSON.stringify(manifest));
  const paths = ['blue', 'amber', 'green'].flatMap(color => Array.from({ length: 3 }, (_, frame) => `icon-activity-${color}-${frame}.svg`)).concat('icon-recent-blue.svg');
  await writeFile(join(addon, 'test-runner.js'), `(async () => {
    const paths = ${JSON.stringify(paths)}, applied = [];
    try {
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 280;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f5f6fa'; ctx.fillRect(0,0,480,280);
      ctx.font = '14px sans-serif'; ctx.fillStyle = '#172337';
      ctx.fillText('Live: three larger frames from left to right', 16, 22);
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i]; await browser.browserAction.setIcon({path}); applied.push(path);
        const image = new Image(); image.src = browser.runtime.getURL(path); await image.decode();
        if (image.naturalWidth !== 96 || image.naturalHeight !== 96) throw Error('Invalid SVG size: '+path);
        const x = 16 + (i % 3) * 112, y = 36 + Math.floor(i / 3) * 60;
        ctx.drawImage(image, x, y, 48, 48); ctx.drawImage(image, x+52, y+16, 32, 32);
        ctx.drawImage(image, x+86, y+32, 16, 16);
      }
      ctx.fillText('After motion: still dots for 10 seconds', 126, 256);
      await fetch(${JSON.stringify(endpoint)}, {method:'POST',body:JSON.stringify({ok:true,applied,browser:await browser.runtime.getBrowserInfo(),png:canvas.toDataURL('image/png').split(',')[1]})});
    } catch (error) {
      await fetch(${JSON.stringify(endpoint)}, {method:'POST',body:JSON.stringify({ok:false,error:String(error),stack:error.stack,applied})});
    }
  })();`);
  const firefox = process.env.FIREFOX_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox');
  child = spawn(process.execPath, [join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'), 'run', '--source-dir', addon, '--firefox', firefox, '--firefox-profile', profile, '--keep-profile-changes', '--no-reload', '--no-input', '--no-config-discovery', '--verbose', '--args=-headless'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
  child.on('error', error => finish({ ok: false, error: String(error) }));
  child.on('exit', code => { if (code !== null) finish({ ok: false, error: `web-ext exited ${code}` }); });
  timer = setTimeout(() => finish({ ok: false, error: 'Firefox icon test timed out' }), 120000);
  const result = await report; clearTimeout(timer);
  await writeFile(join(runRoot, 'browser.log'), log);
  await writeFile(join(runRoot, 'report.json'), JSON.stringify({ ...result, png: undefined }, null, 2));
  assert.equal(result.ok, true, result.error); assert.deepEqual(result.applied, paths);
  const png = Buffer.from(result.png, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await writeFile(join(runRoot, 'preview.png'), png);
  console.log(`Firefox ${result.browser.version}: all 10 toolbar icons applied and rendered. Evidence: ${runRoot}`);
} finally {
  clearTimeout(timer);
  if (child?.pid) {
    if (process.platform === 'win32') await new Promise(done => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, done));
    else child.kill('SIGTERM');
  }
  server.closeAllConnections(); await new Promise(done => server.close(done));
}
