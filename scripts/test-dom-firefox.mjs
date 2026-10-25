// Isolated headless Firefox integration; never touches the user's profile or host.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = randomUUID(), runRoot = join(root,'work',`dom-firefox-${token}`);
const addon = join(runRoot,'extension'), profile = join(runRoot,'profile');
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>DOM fixture</title></head><body>
<h1>Visible DOM fixture</h1><label for="name">Name</label><input id="name" value="old">
<label for="check">Accept terms</label><input id="check" type="checkbox">
<select id="select"><option value="a">Alpha</option><option value="b">Beta</option><option value="c" disabled>Disabled</option></select>
<button id="submit" type="button">Submit</button><a href="/next">Next page</a><input type="password" value="secret">
<button hidden>Hidden</button><button disabled>Disabled</button><a href="javascript:alert(1)">Script link</a>
<iframe src="/embedded" title="Embedded fixture"></iframe><output id="events">No events</output><script>
const events=[];for(const type of ['input','change'])document.getElementById('name').addEventListener(type,event=>{events.push(type);document.getElementById('events').textContent=events.join(',');});
document.getElementById('submit').addEventListener('click',()=>{document.getElementById('submit').textContent='Clicked once';});
</script></body></html>`;
let child,timer,browserLog='',resolveReport;
const report = new Promise(resolve => { resolveReport=resolve; });
const server=http.createServer(async(request,response)=>{
  if(request.method==='POST'&&request.url===`/report/${token}`){
    try{const chunks=[];let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>128*1024)throw new Error('Report too large');chunks.push(chunk);}const result=JSON.parse(Buffer.concat(chunks).toString());response.writeHead(200).end('ok');resolveReport(result);}
    catch(error){response.writeHead(400).end('invalid');resolveReport({ok:false,error:String(error)});}return;
  }
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(request.url === '/embedded' ? '<!doctype html><p>Embedded fixture</p>' : fixture);
});
async function runTests(origin,token){
  const checks=[];let service,read,write,tabId;
  const equal=(name,actual,expected)=>{const passed=JSON.stringify(actual)===JSON.stringify(expected);checks.push({name,passed,actual});if(!passed)throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);};
  const rejects=async(name,promise,code)=>{try{await promise;throw new Error(`${name}: accepted unexpectedly`);}catch(error){equal(name,error.code,code);}};
  const loaded=async()=>{const deadline=Date.now()+10000;while(Date.now()<deadline){const tab=await browser.tabs.get(tabId);if(tab.status==='complete'&&tab.url===origin+'/fixture')return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Tab did not reach fixture URL');};
  const nextLoad=()=>new Promise((resolve,reject)=>{
    const done=()=>{clearTimeout(timeout);browser.webNavigation.onCompleted.removeListener(listener);};
    const listener=details=>{if(details.frameId===0&&details.url===origin+'/fixture'&&(tabId===undefined||details.tabId===tabId)){done();resolve();}};
    const timeout=setTimeout(()=>{done();reject(new Error('Fixture navigation did not complete'));},10000);
    browser.webNavigation.onCompleted.addListener(listener);
  });
  const send=result=>fetch(`${origin}/report/${token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(result)});
  try{
    const browserInfo=await browser.runtime.getBrowserInfo();
    const initialLoad=nextLoad();const tab=await browser.tabs.create({url:origin+'/fixture',active:true});tabId=tab.id;await initialLoad;await loaded();
    read=new FirefoxBridgePolicy.ContentAccess(browser,{settings:{enabled:true,contentMode:'allow',contentScope:'all'}});
    let prompts=0,revoke=false;
    write=new FirefoxBridgePolicy.InteractionAccess(browser,{settings:{enabled:true,interactionMode:'ask-every-time',interactionScope:'all'},requestApproval:async request=>{
      prompts++;equal('write prompt is distinct',request.kind,'interaction');
      if(revoke)read.setSettings({enabled:true,contentMode:'deny',contentScope:'all'});
      return true;
    }});
    service=FirefoxBridgeCore.createService(browser,{contentAccess:read,interactionAccess:write});
    const snapshot=await service.handle('read_dom',{tabId});
    const element=label=>snapshot.elements.find(item=>item.label===label);
    const act=(item,action,extra={})=>service.handle('interact',{tabId,documentId:snapshot.documentId,elementId:item.elementId,action,...extra});
    equal('visible text',snapshot.text.includes('Visible DOM fixture'),true);
    equal('password redacted',snapshot.elements.find(item=>item.type==='password').value,null);
    equal('hidden omitted',snapshot.elements.some(item=>item.label==='Hidden'),false);
    equal('reading has not asked for writes',prompts,0);
    equal('checkbox initially unchecked',element('Accept terms').checked,false);
    const filled=await act(element('Name'),'fill',{value:'Changed in Firefox'});equal('fill dispatched',filled.dispatched,true);
    await act(element('Accept terms'),'set_checked',{checked:true});
    await act(snapshot.elements.find(item=>item.tag==='select'),'select',{value:'b'});
    await act(element('Submit'),'click');
    const updated=await service.handle('read_dom',{tabId});
    equal('native input value',updated.elements.find(item=>item.label==='Name').value,'Changed in Firefox');
    equal('native checkbox state',updated.elements.find(item=>item.label==='Accept terms').checked,true);
    equal('native selected value',updated.elements.find(item=>item.tag==='select').value,'b');
    equal('page button handler ran',updated.elements.some(item=>item.label==='Clicked once'),true);
    equal('input and change reached page listeners',(await service.handle('read_dom',{tabId,selector:'#events'})).text,'input,change');
    await rejects('disabled button refused',act(element('Disabled'),'click'),'ELEMENT_DISABLED');
    await rejects('javascript link refused',act(element('Script link'),'click'),'RESTRICTED_URL');
    write.setSettings({interactionMode:'deny',interactionScope:'all'});
    await rejects('separate denial overrides content allow',act(element('Name'),'fill',{value:'forbidden'}),'INTERACTION_DENIED');
    write.setSettings({interactionMode:'ask-every-time',interactionScope:'all'});
    revoke=true;
    await rejects('read revocation during write approval stops mutation',act(element('Name'),'fill',{value:'forbidden'}),'PERMISSION_CHANGED');
    revoke=false;read.setSettings({enabled:true,contentMode:'allow',contentScope:'all'});
    equal('denied fill left value unchanged',(await service.handle('read_dom',{tabId})).elements.find(item=>item.label==='Name').value,'Changed in Firefox');
    const reloadCompleted=nextLoad();await browser.tabs.reload(tabId);await reloadCompleted;await loaded();
    await rejects('same-URL reload rejects old document references',act(element('Name'),'fill',{value:'forbidden'}),'PAGE_CHANGED');
    read.setSettings({enabled:true,contentMode:'deny',contentScope:'active'});
    write.setSettings({enabled:true,interactionMode:'deny',interactionScope:'active'});
    const applyRules=rules=>{read.setSiteRules(rules);write.setSiteRules(rules);};
    applyRules({readOnly:[{type:'url',value:origin+'/fixture'}]});
    const allowedRead=await service.handle('read_dom',{tabId});
    equal('read exception overrides normal content denial',allowedRead.text.includes('Visible DOM fixture'),true);
    const field=allowedRead.elements.find(item=>item.label==='Name');
    const fill=()=>service.handle('interact',{tabId,documentId:allowedRead.documentId,elementId:field.elementId,action:'fill',value:'Permanent full access'});
    await rejects('read exception keeps normal write denial',fill(),'INTERACTION_DENIED');
    applyRules({fullAccess:[{type:'url',value:origin+'/fixture'}]});
    equal('full exception overrides both general denials',(await fill()).dispatched,true);
    equal('full exception reached actual input',(await service.handle('read_dom',{tabId})).elements.find(item=>item.label==='Name').value,'Permanent full access');
    applyRules({fullAccess:[{type:'url',value:origin+'/fixture'}],blocked:[{type:'host',value:'127.0.0.1'}]});
    await rejects('block overrides full exception for reads',service.handle('read_content',{tabId}),'SITE_BLOCKED');
    await rejects('block overrides full exception for DOM writes',fill(),'SITE_BLOCKED');
    equal('blocked tabs still expose URL metadata',(await service.handle('get_tabs',{tabIds:[tabId]})).results[0].result.url,origin+'/fixture');
    read.setSettings({enabled:true,contentMode:'allow',contentScope:'all'});
    applyRules({blocked:[{type:'url',value:origin+'/embedded'}]});
    for(const method of ['save_png','save_html','save_pdf'])await rejects(`${method} blocks embedded forbidden document`,service.handle(method,{tabId}),'SITE_BLOCKED');
    applyRules({});
    await send({ok:true,browser:browserInfo,checks,approvalAdapter:'in-test explicit allow/deny; real Firefox DOM and isolated extension; no user profile or native host'});
  }catch(error){await send({ok:false,error:String(error),code:error.code,stack:error.stack,checks});}
  finally{service?.tracker.stop();read?.windowTracker.stop();write?.windowTracker.stop();}
}
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try{
  await mkdir(profile,{recursive:true});await cp(join(root,'extension'),addon,{recursive:true});
  const manifest=JSON.parse(await readFile(join(addon,'manifest.json'),'utf8'));
  manifest.browser_specific_settings.gecko.id=`dom-test-${token}@local.invalid`;
  manifest.background.scripts=manifest.background.scripts.filter(file=>file!=='background.js').concat('test-runner.js');
  await writeFile(join(addon,'manifest.json'),JSON.stringify(manifest));
  await writeFile(join(addon,'test-runner.js'),`(${runTests.toString()})(${JSON.stringify(origin)},${JSON.stringify(token)});`);
  const firefox=process.env.FIREFOX_BINARY||(process.platform==='win32'?'C:\\Program Files\\Mozilla Firefox\\firefox.exe':'firefox');
  child=spawn(process.execPath,[join(root,'node_modules','web-ext','bin','web-ext.js'),'run','--source-dir',addon,'--firefox',firefox,'--firefox-profile',profile,'--keep-profile-changes','--no-reload','--no-input','--no-config-discovery','--verbose','--args=-headless'],{cwd:root,windowsHide:true,detached:process.platform!=='win32',env:{...process.env,MOZ_HEADLESS:'1'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',data=>{browserLog+=data;});child.stderr.on('data',data=>{browserLog+=data;});
  child.on('error',error=>resolveReport({ok:false,error:String(error)}));child.on('exit',(code,signal)=>resolveReport({ok:false,error:`web-ext exited (${code??signal})`}));
  timer=setTimeout(()=>resolveReport({ok:false,error:'DOM integration timeout'}),60000);
  const result=await report;clearTimeout(timer);
  await writeFile(join(runRoot,'report.json'),JSON.stringify(result,null,2));await writeFile(join(runRoot,'browser.log'),browserLog);
  assert.equal(result.ok,true,`${JSON.stringify(result)}; evidence: ${runRoot}`);
  console.log(`Firefox ${result.browser.version}: ${result.checks.length} DOM checks passed. Evidence: ${runRoot}`);
}finally{
  clearTimeout(timer);
  if(child?.pid&&child.exitCode===null&&child.signalCode===null){
    if(process.platform==='win32')await new Promise(resolve=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},resolve));
    else try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
  }
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
