// Optional browser integration test. Uses a separate headless Firefox profile.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = join(root, 'work', `export-firefox-${randomUUID()}`);
const addon = join(runRoot, 'extension'), profile = join(runRoot, 'profile');
const token = randomUUID();
let html = '', reportResolve, child, browserLog = '', timer;
const report = new Promise(resolveReport => { reportResolve = resolveReport; });
const resources = [];
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI0cAAAAASUVORK5CYII=', 'base64');
const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><h1 id="title">Initial</h1><a href="/target">Normal link</a><a id="js-link" href="#" onclick="location.href='/target'">JS link</a><input id="state" value="initial"><img src="/image.png"><canvas id="art" width="900" height="800"></canvas><iframe src="/frame"></iframe><div style="height:2200px"></div><img loading="lazy" src="/lazy.png"><div id="bottom">BOTTOM MARKER</div><script>document.getElementById('title').textContent='Rendered snapshot';document.getElementById('state').value='Current input';const ctx=document.getElementById('art').getContext('2d'),data=ctx.createImageData(900,800);for(let i=0;i<data.data.length;i+=4){data.data[i]=(i*13)%251;data.data[i+1]=(i*7>>8)%251;data.data[i+2]=(i*19>>16)%251;data.data[i+3]=255}ctx.putImageData(data,0,0);setTimeout(()=>scrollTo(0,500),50);</script></body></html>`;
const server = http.createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === `/report/${token}`) {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 20 * 1024 * 1024) { response.writeHead(413).end(); return; } chunks.push(chunk); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200).end('ok'); reportResolve(result); return;
  }
  if (request.method === 'POST' && request.url === `/html/${token}`) {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    html = Buffer.concat(chunks).toString('utf8'); response.writeHead(200).end('ok'); return;
  }
  resources.push(request.url);
  const routes = {
    '/fixture': ['text/html', fixture], '/saved': ['text/html', html],
    '/style.css': ['text/css', 'body{margin:0;background:white;font-family:sans-serif}h1{color:rgb(24,95,160)}#bottom{height:80px;background:rgb(255,0,0)}iframe{display:block}'],
    '/image.png': ['image/png', image], '/lazy.png': ['image/png', image],
    '/frame': ['text/html', '<!doctype html><html><body><b>FRAME MARKER</b><script>document.body.dataset.changed="yes"</script></body></html>'],
  };
  const route = routes[request.url]; if (!route) { response.writeHead(404).end('missing'); return; }
  response.writeHead(200, { 'Content-Type': route[0] }).end(route[1]);
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  await mkdir(profile, { recursive: true });
  await cp(join(root, 'extension'), addon, { recursive: true });
  const manifest = JSON.parse(await readFile(join(addon, 'manifest.json'), 'utf8'));
  manifest.browser_specific_settings.gecko.id = `export-test-${token}@local.invalid`;
  manifest.background.scripts = manifest.background.scripts.filter(file => file !== 'background.js').concat('test-runner.js');
  await writeFile(join(addon, 'manifest.json'), JSON.stringify(manifest));
  const runner = `/* global browser, FirefoxBridgeCore */
  (async () => {
    const origin = ${JSON.stringify(origin)}, token = ${JSON.stringify(token)};
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const injection = async (id, code) => (await browser.tabs.executeScript(id,{code,frameId:0}))[0];
    const loaded = async id => { for(let i=0;i<200;i++){if((await browser.tabs.get(id)).status==='complete')return;await wait(50)}throw Error('tab did not load'); };
    try {
      const service = FirefoxBridgeCore.createService(browser);
      const tab = await browser.tabs.create({url:origin+'/fixture',active:true}); await loaded(tab.id); await wait(250);
      const before = await injection(tab.id,'({x:scrollX,y:scrollY,width:document.documentElement.clientWidth,height:document.scrollingElement.scrollHeight})');
      const metadata = await service.handle('save_png',{tabId:tab.id});
      let png=''; for(let index=0;;index++){const chunk=await service.handle('export_chunk',{transferId:metadata.transferId,index});png+=atob(chunk.data);if(chunk.done)break}
      await service.handle('export_release',{transferId:metadata.transferId});
      const pngBase64=btoa(png);
      const after = await injection(tab.id,'({x:scrollX,y:scrollY,behavior:document.documentElement.style.getPropertyValue("scroll-behavior")})');
      const archive = await service.handle('save_html',{tabId:tab.id,loadDeferred:true});
      const parts=[];for(let index=0;;index++){const chunk=await service.handle('export_chunk',{transferId:archive.transferId,index});parts.push(Uint8Array.from(atob(chunk.data),c=>c.charCodeAt(0)));if(chunk.done)break}
      await service.handle('export_release',{transferId:archive.transferId});
      const blob=new Blob(parts,{type:'text/html'});await fetch(origin+'/html/'+token,{method:'POST',body:blob});
      await browser.tabs.update(tab.id,{url:origin+'/saved'});await loaded(tab.id);await wait(200);
      const snapshot=await injection(tab.id,'({title:document.getElementById("title")?.textContent,state:document.getElementById("state")?.value,link:document.getElementById("js-link")?.href,scripts:[...document.scripts].filter(s=>!s.type||s.type==="text/javascript").length,images:[...document.images].map(i=>({src:i.src,complete:i.complete,naturalWidth:i.naturalWidth})),frame:document.querySelector("iframe")?.contentDocument?.body?.textContent})');
      await fetch(origin+'/report/'+token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ok:true,before,after,metadata,archive,snapshot,png:pngBase64})});
    } catch(error) {await fetch(origin+'/report/'+token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ok:false,error:String(error),stack:error.stack})});}
  })();`;
  await writeFile(join(addon, 'test-runner.js'), runner);
  const firefox = process.env.FIREFOX_BINARY || (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : 'firefox');
  child = spawn(process.execPath, [join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js'), 'run', '--source-dir', addon, '--firefox', firefox, '--firefox-profile', profile, '--keep-profile-changes', '--no-reload', '--no-input', '--no-config-discovery', '--verbose', '--args=-headless'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { browserLog += data; }); child.stderr.on('data', data => { browserLog += data; });
  child.on('error', error => reportResolve({ ok: false, error: String(error) }));
  child.on('exit', code => { if (code !== null) reportResolve({ ok: false, error: `web-ext exited ${code}`, log: browserLog }); });
  timer = setTimeout(() => reportResolve({ ok: false, error: 'Browser integration timed out', log: browserLog }), 240000);
  const result = await report; clearTimeout(timer);
  await writeFile(join(runRoot, 'report.json'), JSON.stringify({ ...result, png: undefined, resources }, null, 2));
  await writeFile(join(runRoot, 'browser.log'), browserLog);
  if (!result.ok) throw new Error(JSON.stringify(result));
  const png = Buffer.from(result.png, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), result.before.width); assert.equal(png.readUInt32BE(20), result.metadata.height);
  assert.ok(result.metadata.height > result.before.height - 20);
  assert.equal(result.before.y, result.after.y); assert.equal(result.after.behavior, '');
  assert.equal(result.snapshot.title, 'Rendered snapshot'); assert.equal(result.snapshot.state, 'Current input');
  assert.equal(result.snapshot.scripts, 0); assert.equal(result.snapshot.link, origin + '/target');
  assert.ok(result.snapshot.images.every(image => image.complete && image.naturalWidth > 0 && /^data:/.test(image.src)));
  assert.match(html, /FRAME MARKER/); assert.match(html, /Content-Security-Policy/i);
  const savedIndex = resources.lastIndexOf('/saved');
  assert.ok(savedIndex >= 0); assert.deepEqual(resources.slice(savedIndex + 1).filter(url => url !== '/favicon.ico'), []);
  await writeFile(join(runRoot, 'capture.png'), png); await writeFile(join(runRoot, 'snapshot.html'), html);
  console.log(`Firefox PNG and offline HTML integration passed. Evidence: ${runRoot}`);
} finally {
  clearTimeout(timer);
  if (child?.pid) {
    if (process.platform === 'win32') await new Promise(resolveKill => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, resolveKill));
    else child.kill('SIGTERM');
  }
  server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
}
