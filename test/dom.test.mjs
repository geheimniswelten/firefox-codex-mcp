import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { Window } from 'happy-dom';
import '../extension/dom.js';
import '../extension/policy.js';
import { TOOL_DEFINITIONS } from '../server/tools.mjs';

const { createDom, validate } = globalThis.FirefoxBridgeDom;
const { ContentAccess, InteractionAccess, FIVE_DAYS_MS, SESSION_MS } = globalThis.FirefoxBridgePolicy;
const definitions = new Map(TOOL_DEFINITIONS.map(tool => [tool.method,tool]));
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].forEach(fn => fn(...args)) }; };
function fixture(t, options = {}) {
  let now = 1000, injections = 0, writePrompts = 0, readPrompts = 0;
  const window = new Window({ url: 'https://example.test/form', settings: { enableJavaScriptEvaluation: false } });
  t.after(() => window.close());
  window.document.body.innerHTML = '<main id="form"><h1>Visible title</h1><label for="name">Name</label><input id="name" value="old"><label for="check">Accept terms</label><input id="check" type="checkbox"><select id="select"><option value="a">Alpha</option><option value="b">Beta</option><option value="c" disabled>Disabled</option></select><button id="submit">Submit</button><a id="link" href="/next">Next page</a><input id="secret" type="password" value="secret"><button id="disabled" disabled>Disabled</button><button id="hidden" hidden>Hidden</button><a id="js" href="javascript:alert(1)">Script link</a><textarea id="readonly" readonly>Read only</textarea></main>';
  window.HTMLElement.prototype.getClientRects = function() { return this.hidden ? [] : [{ x:0,y:0,width:100,height:20 }]; };
  const storage = {}, tabValues = new Map();
  const tabs = new Map([[1,{id:1,url:window.location.href,title:'Fixture',active:true,discarded:false}],[2,{id:2,url:window.location.href,title:'Other',active:false,discarded:false}]]);
  let realm;
  const newRealm = () => {
    class Clock extends Date { static now() { return now; } }
    realm = vm.createContext({ document:window.document, location:window.location, crypto:webcrypto, Date:Clock,
      HTMLInputElement:window.HTMLInputElement, HTMLTextAreaElement:window.HTMLTextAreaElement, HTMLSelectElement:window.HTMLSelectElement, Event:window.Event,
      getComputedStyle: node => { const style=window.getComputedStyle(node); return { display:style.display, visibility:style.visibility, opacity:style.opacity || '1' }; } });
  };
  newRealm();
  const browser = {
    storage:{local:{get:async key=>({[key]:structuredClone(storage[key])}),set:async value=>Object.assign(storage,structuredClone(value))}},
    sessions:{getTabValue:async(id,key)=>tabValues.get(`${id}:${key}`),setTabValue:async(id,key,value)=>tabValues.set(`${id}:${key}`,value)},
    tabs:{onUpdated:event(),onRemoved:event(),onCreated:event(),get:async id=>structuredClone(tabs.get(id)),query:async()=>[...tabs.values()].map(tab=>structuredClone(tab)),
      executeScript:async(id,{code,frameId,allFrames})=>{ assert.equal(frameId,0);assert.equal(allFrames,false);injections++;options.beforeInject?.(code);return [vm.runInContext(code,realm)]; }},
    windows:{onFocusChanged:event(),getLastFocused:async()=>({id:1,type:'normal',tabs:[...tabs.values()]}),get:async()=>({id:1,type:'normal',tabs:[...tabs.values()]}),getAll:async()=>[{id:1,type:'normal',tabs:[...tabs.values()]}]}
  };
  const read = new ContentAccess(browser,{now:()=>now,settings:{enabled:true,contentMode:options.readMode || 'allow',contentScope:options.readScope || 'all'},
    requestApproval:async request=>{readPrompts++;return options.readApprove ? options.readApprove(request) : true;}});
  const write = new InteractionAccess(browser,{now:()=>now,settings:{enabled:true,interactionMode:options.writeMode || 'ask-every-time',interactionScope:options.writeScope || 'all'},
    requestApproval:async request=>{writePrompts++;return options.writeApprove ? options.writeApprove(request) : true;}});
  const dom=createDom(browser,{contentAccess:read,interactionAccess:write});
  const snapshot=()=>dom.handle('read_dom',{tabId:1,selector:'#form'});
  return { browser,read,write,dom,window,storage,tabValues,tabs,snapshot,newRealm,
    element:(snapshot,id)=>snapshot.elements.find(element=>element.elementId && element.label===id),
    action:(snapshot,element,action,extra={})=>dom.handle('interact',{tabId:1,documentId:snapshot.documentId,elementId:element.elementId,action,...extra}),
    now:()=>now,advance:ms=>{now+=ms;},injections:()=>injections,writePrompts:()=>writePrompts,readPrompts:()=>readPrompts };
}

test('DOM reads visible text, controls, state, link targets and redacts password values without changing the page', async t=>{
  const f=fixture(t);const before=f.window.document.body.innerHTML;const snapshot=await f.snapshot();
  assert.match(snapshot.text,/Visible title/);assert.match(snapshot.documentId,/^[0-9a-f-]{36}$/);
  assert.equal(f.element(snapshot,'Name').value,'old');assert.equal(f.element(snapshot,'Accept terms').checked,false);
  assert.equal(f.element(snapshot,'Next page').href,'https://example.test/next');
  assert.equal(snapshot.elements.find(element=>element.type==='password').value,null);
  assert.equal(snapshot.elements.find(element=>element.type==='password').valueRedacted,true);
  assert.equal(snapshot.elements.some(element=>element.label==='Hidden'),false);
  assert.equal(f.window.document.body.innerHTML,before);assert.equal(f.writePrompts(),0);
  const page=await f.dom.handle('read_dom',{tabId:1,limit:2,offset:2,maxChars:3,visibleOnly:false});
  assert.equal(page.returned,2);assert.equal(page.nextOffset,4);assert.equal(page.text.length,3);assert.equal(page.textTruncated,true);
});

test('permanent site rules enforce denial before injection and full access bypasses both general deny modes', async t => {
  const f = fixture(t, { readMode: 'deny', writeMode: 'deny' });
  const rules = { readOnly: [{ type: 'domain', value: 'example.test' }] };
  f.read.setSiteRules(rules); f.write.setSiteRules(rules);
  const snapshot = await f.snapshot();
  await assert.rejects(f.action(snapshot, f.element(snapshot, 'Name'), 'fill', { value: 'forbidden' }), { code: 'INTERACTION_DENIED' });
  const full = { fullAccess: [{ type: 'domain', value: 'example.test' }] };
  f.read.setSiteRules(full); f.write.setSiteRules(full);
  await f.action(snapshot, f.element(snapshot, 'Name'), 'fill', { value: 'allowed by site rule' });
  assert.equal(f.window.document.getElementById('name').value, 'allowed by site rule');
  assert.equal(f.readPrompts(), 0); assert.equal(f.writePrompts(), 0);
  const blocked = { ...full, blocked: [{ type: 'host', value: 'example.test' }] };
  f.read.setSiteRules(blocked); f.write.setSiteRules(blocked);
  const before = f.injections();
  await assert.rejects(f.snapshot(), { code: 'SITE_BLOCKED' });
  await assert.rejects(f.action(snapshot, f.element(snapshot, 'Name'), 'fill', { value: 'forbidden' }), { code: 'SITE_BLOCKED' });
  assert.equal(f.injections(), before);
});
test('fixed actions fill controls with native setters, send events, set checkboxes, select values and click once', async t=>{
  const f=fixture(t);const snapshot=await f.snapshot();const field=f.window.document.getElementById('name');const events=[];
  field.addEventListener('input',()=>events.push('input'));field.addEventListener('change',()=>events.push('change'));
  Object.defineProperty(field,'value',{get:()=>Object.getOwnPropertyDescriptor(f.window.HTMLInputElement.prototype,'value').get.call(field),set:()=>assert.fail('framework instance setter must not intercept fill')});
  await f.action(snapshot,f.element(snapshot,'Name'),'fill',{value:'new value'});assert.equal(field.value,'new value');assert.deepEqual(events,['input','change']);
  await f.action(snapshot,f.element(snapshot,'Accept terms'),'set_checked',{checked:true});assert.equal(f.window.document.getElementById('check').checked,true);
  const select=snapshot.elements.find(element=>element.tag==='select');await f.action(snapshot,select,'select',{value:'b'});assert.equal(f.window.document.getElementById('select').value,'b');
  let clicks=0;f.window.document.getElementById('submit').addEventListener('click',()=>clicks++);
  const result=await f.action(snapshot,f.element(snapshot,'Submit'),'click');assert.equal(clicks,1);assert.equal(result.dispatched,true);assert.equal(result.eventsTrusted,false);
  assert.equal(f.writePrompts(),4);
});
test('writes are denied by default and unlimited allow cannot be configured', async t=>{
  const f=fixture(t);const snapshot=await f.snapshot();const defaultWrite=new InteractionAccess(f.browser);
  assert.equal(defaultWrite.settings.contentMode,'deny');defaultWrite.setSettings({interactionMode:'allow',interactionScope:'all'});assert.equal(defaultWrite.settings.contentMode,'deny');
  const denied=createDom(f.browser,{contentAccess:f.read,interactionAccess:defaultWrite});const before=f.injections();
  await assert.rejects(denied.handle('interact',{tabId:1,documentId:snapshot.documentId,elementId:f.element(snapshot,'Submit').elementId,action:'click'}),{code:'INTERACTION_DENIED'});
  assert.equal(f.injections(),before);
});
test('normal content denial prevents writes even when the separate interaction rule allows asking', async t=>{
  const f=fixture(t);const snapshot=await f.snapshot();f.read.setSettings({enabled:true,contentMode:'deny',contentScope:'all'});
  const before=f.injections();await assert.rejects(f.action(snapshot,f.element(snapshot,'Submit'),'click'),{code:'CONTENT_DENIED'});assert.equal(f.injections(),before);assert.equal(f.writePrompts(),0);
});
test('normal approval expiring or being revoked during write approval prevents every mutation', async t=>{
  for(const revoke of [false,true]) {
    let f;f=fixture(t,{readMode:'ask-session',writeApprove:()=>{if(revoke)f.read.setSettings({enabled:true,contentMode:'deny',contentScope:'all'});else f.advance(SESSION_MS+1);return true;}});
    const snapshot=await f.snapshot();await assert.rejects(f.action(snapshot,f.element(snapshot,'Name'),'fill',{value:'forbidden'}),{code:revoke?'PERMISSION_CHANGED':'SESSION_EXPIRED'});
    assert.equal(f.window.document.getElementById('name').value,'old');
  }
});
test('the shortest actual grant deadline is enforced in the page before mutation', async t=>{
  let f;f=fixture(t,{readMode:'ask-session',writeMode:'ask-five-days',beforeInject:code=>{if(code.includes('"method":"interact"'))f.advance(SESSION_MS+1);}});
  const snapshot=await f.snapshot();await assert.rejects(f.action(snapshot,f.element(snapshot,'Name'),'fill',{value:'forbidden'}),{code:'SESSION_EXPIRED'});
  assert.equal(f.window.document.getElementById('name').value,'old');
});
test('other tabs need both applicable scopes, rejecting content approval cannot trigger write approval', async t=>{
  const f=fixture(t,{readScope:'active',writeScope:'all',readApprove:()=>false});
  await assert.rejects(f.dom.handle('read_dom',{tabId:2}),{code:'CONTENT_DENIED'});assert.equal(f.readPrompts(),1);assert.equal(f.writePrompts(),0);
});
test('exact-node references reject replacements and same-URL reloads before write approval', async t=>{
  const f=fixture(t);let snapshot=await f.snapshot();const button=f.element(snapshot,'Submit');
  f.window.document.getElementById('submit').outerHTML='<button id="submit">Replacement</button>';
  await assert.rejects(f.action(snapshot,button,'click'),{code:'STALE_ELEMENT'});assert.equal(f.writePrompts(),0);
  snapshot=await f.snapshot();f.newRealm();await assert.rejects(f.action(snapshot,f.element(snapshot,'Replacement'),'click'),{code:'PAGE_CHANGED'});assert.equal(f.writePrompts(),0);
});
test('URL changes during approval are caught before DOM injection and detached references cannot be reused', async t=>{
  let f;f=fixture(t,{writeApprove:()=>{f.tabs.get(1).url='https://example.test/new';f.browser.tabs.onUpdated.emit(1,{url:'https://example.test/new'});return true;}});
  const snapshot=await f.snapshot();await assert.rejects(f.action(snapshot,f.element(snapshot,'Submit'),'click'),{code:'PAGE_CHANGED'});
});
test('disabled, readonly, hidden, JavaScript links and unsupported operations cannot mutate', async t=>{
  const f=fixture(t);const snapshot=await f.dom.handle('read_dom',{tabId:1,visibleOnly:false});
  for(const [label,action,extra,code] of [['Disabled','click',{},'ELEMENT_DISABLED'],['Hidden','click',{},'ELEMENT_NOT_VISIBLE'],['Read only','fill',{value:'no'},'ELEMENT_READ_ONLY'],['Script link','click',{},'RESTRICTED_URL'],['Submit','fill',{value:'no'},'UNSUPPORTED_ELEMENT']]) {
    await assert.rejects(f.action(snapshot,f.element(snapshot,label),action,extra),{code});
  }
  const select=snapshot.elements.find(element=>element.tag==='select');await assert.rejects(f.action(snapshot,select,'select',{value:'c'}),{code:'ELEMENT_DISABLED'});
});
test('interaction five-day grants persist separately, survive restart and never extend themselves', async t=>{
  const f=fixture(t,{readMode:'ask-five-days',writeMode:'ask-five-days'});const snapshot=await f.snapshot();await f.action(snapshot,f.element(snapshot,'Name'),'fill',{value:'allowed'});
  const read=f.storage.bridgeFiveDayApprovals,write=f.storage.bridgeInteractionFiveDayApprovals;
  assert.ok(read&&write);assert.notEqual(read.epoch,write.epoch);assert.equal(write.global.expiresAt-write.global.issuedAt,FIVE_DAYS_MS);
  const expires=write.global.expiresAt;f.advance(1000);await f.action(snapshot,f.element(snapshot,'Name'),'fill',{value:'again'});assert.equal(f.storage.bridgeInteractionFiveDayApprovals.global.expiresAt,expires);assert.equal(f.writePrompts(),1);
  const restored=new InteractionAccess(f.browser,{now:f.now,settings:{interactionMode:'ask-five-days',interactionScope:'all'},requestApproval:async()=>assert.fail('saved grant must restore')});
  await restored.restoreApprovals();await restored.authorize(await f.browser.tabs.get(1),{});assert.equal(restored.expiresAt,expires);
  restored.resetApprovals();await restored.flushApprovals();assert.equal(f.storage.bridgeInteractionFiveDayApprovals.global,null);assert.ok(f.storage.bridgeFiveDayApprovals.global);
});
test('schema and extension validation reject code, attributes, missing references and mismatched action values',()=>{
  const reference={tabId:1,documentId:webcrypto.randomUUID(),elementId:'e1',action:'click'};
  for(const p of [{...reference,code:'alert(1)'},{...reference,attribute:'onclick'},{...reference,value:'x'},{...reference,action:'eval'},{...reference,documentId:null},{...reference,elementId:'selector'},{...reference,action:'fill'},{...reference,action:'set_checked',checked:'true'}]) {
    assert.equal(definitions.get('interact').inputSchema.safeParse(p).success,false);assert.throws(()=>validate('interact',p),{code:'INVALID_PARAMS'});
  }
  assert.equal(definitions.get('interact').inputSchema.safeParse(reference).success,true);
  assert.equal(TOOL_DEFINITIONS.some(tool=>/javascript|eval|execute_script/.test(tool.method)),false);
});
