const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {KEYS,LOCK,createStore}=require('../commit-core.js');

class OrderedLocks{
 constructor(){this.tail=Promise.resolve();this.held=false;this.calls=0;}
 request(name,options,callback){assert.equal(name,LOCK);assert.equal(options.mode,'exclusive');this.calls++;const task=this.tail.then(async()=>{assert.equal(this.held,false);this.held=true;try{return await callback();}finally{this.held=false;}});this.tail=task.catch(()=>{});return task;}
}
function fixture(){
 const disk=new Map([['unrelated-sentinel','KEEP']]),writes=[],removals=[],locks=new OrderedLocks();let sequence=0,unsupported=false,failure=null,uuidCalls=0;
 const storage={getItem(key){assert.ok(Object.values(KEYS).includes(key));return disk.get(key)??null;},setItem(key,value){assert.ok(Object.values(KEYS).includes(key));writes.push(key);disk.set(key,value);},removeItem(key){assert.ok(Object.values(KEYS).includes(key));removals.push(key);disk.delete(key);}};
 const make=()=>createStore({storage,locks,randomUUID:()=>{uuidCalls++;return '00000000-0000-4000-8000-'+(++sequence).toString(16).padStart(12,'0');},now:()=> '2026-11-20T00:00:00.000Z',unavailable:()=>unsupported,failWrite:key=>failure==='all'||failure===key});
 return {disk,writes,removals,locks,make,setUnsupported:v=>unsupported=v,setFailure:v=>failure=v,uuidCalls:()=>uuidCalls};
}
async function reserved(f){const store=f.make();await store.initialize();const result=await store.update({type:'reserve',itemId:'dummy-stock-1',expectedRev:0});assert.equal(result.kind,'applied');const d=store.inspect().data.deals[0];return {store,id:{dealId:d.id,purchaseId:d.purchaseId}};}
async function sent(f){const {store,id}=await reserved(f);assert.equal((await store.update({type:'prepare',...id})).kind,'applied');assert.equal((await store.update({type:'sent',...id})).kind,'applied');return {store,id:{...id,sentAt:store.inspect().data.deals[0].parts[0].sentAt}};}

test('two independent callers keep both registrations in the latest JSON',async()=>{
 const f=fixture(),a=f.make(),b=f.make();await a.initialize();const results=await Promise.all([a.update({type:'register',itemId:'dummy-stock-a'}),b.update({type:'register',itemId:'dummy-stock-b'})]);assert.deepEqual(results.map(x=>x.kind),['applied','applied']);assert.equal(a.inspect().data.items.length,3);assert.equal(a.inspect().data.rev,2);
});
test('20 independently scheduled conflicts reserve the same stock only once per run',async()=>{
 for(let i=0;i<20;i++){const f=fixture(),a=f.make(),b=f.make();await a.initialize();const intent={type:'reserve',itemId:'dummy-stock-1',expectedRev:0};const result=await Promise.all(i%2?[b.update(intent),a.update(intent)]:[a.update(intent),b.update(intent)]);assert.deepEqual(result.map(x=>x.kind).sort(),['applied','changed']);assert.equal(a.inspect().data.rev,1);assert.equal(a.inspect().data.deals.length,1);}
});
test('confirmation waits outside the lock and a changed revision requests reconfirmation',async()=>{
 const f=fixture(),a=f.make(),b=f.make();await a.initialize();let answer;const calls=f.locks.calls;const pending=a.confirmOutside({type:'reserve',itemId:'dummy-stock-1',expectedRev:0},()=>new Promise(resolve=>answer=resolve));assert.equal(f.locks.calls,calls);assert.equal(f.locks.held,false);assert.equal((await b.update({type:'register',itemId:'dummy-stock-other'})).kind,'applied');answer(true);assert.equal((await pending).kind,'changed');assert.equal(a.inspect().data.deals.length,0);
});
test('cancelled confirmation never requests a write lock',async()=>{
 const f=fixture(),a=f.make();await a.initialize();const calls=f.locks.calls;assert.equal((await a.confirmOutside({type:'reserve',itemId:'dummy-stock-1'},async()=>false)).kind,'unchanged');assert.equal(f.locks.calls,calls);
});
test('receipt and registration overlap without losing either change',async()=>{
 const f=fixture(),{store,id}=await sent(f),other=f.make();const previous=store.inspect().data.rev;
 await Promise.all([store.update({type:'receipt',...id}),other.update({type:'register',itemId:'dummy-stock-next'})]);const data=store.inspect().data;assert.equal(data.rev,previous+2);assert.equal(data.items.length,2);assert.equal(data.deals[0].parts[0].history.state,'recorded');
});
test('sentAt and pending history are saved in one write, before a mock response',async()=>{
 const f=fixture(),{store,id}=await reserved(f);await store.update({type:'prepare',...id});const before=f.writes.filter(k=>k===KEYS.data).length;await store.update({type:'sent',...id});assert.equal(f.writes.filter(k=>k===KEYS.data).length,before+1);const p=JSON.parse(f.disk.get(KEYS.data)).deals[0].parts[0];assert.ok(p.sentAt);assert.deepEqual(p.history,{state:'pending',recordedAt:null});
});
test('lost mock response can be retried without changing identity or increasing rev twice',async()=>{
 const f=fixture(),{store,id}=await sent(f);const first=await store.update({type:'receipt',...id});const retry=await f.make().update({type:'receipt',...id});assert.equal(first.kind,'applied');assert.equal(retry.kind,'unchanged');assert.equal(retry.data.rev,first.data.rev);assert.equal(retry.data.deals[0].purchaseId,id.purchaseId);
});
test('save failure never reports success and leaves primary data unchanged',async()=>{
 const f=fixture(),a=f.make();await a.initialize();const before=f.disk.get(KEYS.data);f.setFailure(KEYS.data);const r=await a.update({type:'register',itemId:'dummy-stock-x'});assert.equal(r.kind,'failed');assert.equal(f.disk.get(KEYS.data),before);
});
test('a guard write failure does not commit a reservation',async()=>{
 const f=fixture(),a=f.make();await a.initialize();const before=f.disk.get(KEYS.data);f.setFailure(KEYS.guard);const r=await a.update({type:'reserve',itemId:'dummy-stock-1'});assert.equal(r.kind,'failed');assert.equal(f.disk.get(KEYS.data),before);assert.equal(a.inspect().kind,'ready');
});
test('unused monotonic witness after primary save failure is not a completed reservation',async()=>{
 const f=fixture(),a=f.make();await a.initialize();f.setFailure(KEYS.data);assert.equal((await a.update({type:'reserve',itemId:'dummy-stock-1'})).kind,'failed');f.setFailure(null);assert.equal(a.inspect().data.deals.length,0);assert.equal((await a.update({type:'reserve',itemId:'dummy-stock-1'})).kind,'applied');assert.equal(a.inspect().data.deals.length,1);
});
test('unsupported locking is readonly and creates neither data nor IDs',async()=>{
 const f=fixture(),a=f.make();f.setUnsupported(true);assert.equal((await a.initialize()).kind,'readonly');assert.equal((await a.update({type:'register',itemId:'dummy-stock-x'})).kind,'readonly');assert.equal(f.writes.length,0);assert.equal(f.uuidCalls(),0);
});
test('a failed copy preparation leaves no fixed message or successful result',async()=>{
 const f=fixture(),{store,id}=await reserved(f);f.setFailure(KEYS.data);const result=await store.update({type:'prepare',...id});assert.equal(result.kind,'failed');assert.equal(result.text,undefined);assert.equal(store.inspect().data.deals[0].parts[0].messageSnapshot,null);assert.throws(()=>store.copyText(id));
});
test('fixed unsent message can be copied again after reload without changing time or rev',async()=>{
 const f=fixture(),{store,id}=await reserved(f);const first=await store.update({type:'prepare',...id}),next=f.make(),second=await next.update({type:'prepare',...id});assert.equal(second.kind,'unchanged');assert.equal(second.text,first.text);assert.equal(second.data.rev,first.data.rev);assert.equal(second.data.deals[0].parts[0].copyIntentAt,first.data.deals[0].parts[0].copyIntentAt);assert.equal(next.copyText(id),first.text);
});
test('copy lookup reads current storage and refuses a part sent by another caller',async()=>{
 const f=fixture(),{store,id}=await reserved(f);await store.update({type:'prepare',...id});const other=f.make();await other.update({type:'sent',...id});assert.throws(()=>store.copyText(id),/固定文面/);assert.equal((await store.update({type:'prepare',...id})).kind,'rejected');
});
test('sent confirmation requires prepared text and cannot count the same part twice',async()=>{
 const f=fixture(),{store,id}=await reserved(f);assert.equal((await store.update({type:'sent',...id})).kind,'rejected');await store.update({type:'prepare',...id});const one=await store.update({type:'sent',...id}),two=await store.update({type:'sent',...id});assert.equal(one.kind,'applied');assert.equal(two.kind,'unchanged');assert.equal(two.data.rev,one.data.rev);
});
test('purchase identity rewrite is rejected with no storage change',async()=>{
 const f=fixture(),{store,id}=await reserved(f),before=new Map(f.disk);const result=await store.update({type:'rewriteIdentity',dealId:id.dealId,purchaseId:'p-00000000-0000-4000-8000-999999999999'});assert.equal(result.kind,'rejected');assert.deepEqual(f.disk,before);
});
test('invalid history becomes pending but missing identity becomes recovery, never a new ID',async()=>{
 const f=fixture(),{store}=await sent(f);let raw=JSON.parse(f.disk.get(KEYS.data));raw.deals[0].parts[0].history={state:'recorded',recordedAt:12};f.disk.set(KEYS.data,JSON.stringify(raw));assert.equal(store.inspect().data.deals[0].parts[0].history.state,'pending');delete raw.deals[0].purchaseId;f.disk.set(KEYS.data,JSON.stringify(raw));const ids=f.uuidCalls(),fresh=f.make();assert.equal(fresh.inspect().kind,'recovery');assert.equal((await fresh.initialize()).kind,'recovery');assert.equal((await fresh.update({type:'register',itemId:'dummy-stock-x'})).kind,'recovery');assert.equal(f.uuidCalls(),ids);
});
test('legacy overwrite stays recovery after a fresh instance, preserving the witness',async()=>{
 const f=fixture(),{store}=await reserved(f),guard=f.disk.get(KEYS.guard);assert.equal(store.simulateLegacy().kind,'recovery');const snapshot=f.disk.get(KEYS.data),ids=f.uuidCalls();assert.equal(f.make().inspect().kind,'recovery');assert.equal((await f.make().initialize()).kind,'recovery');assert.equal(f.disk.get(KEYS.data),snapshot);assert.equal(f.disk.get(KEYS.guard),guard);assert.equal(f.uuidCalls(),ids);
});
test('changing a valid-looking purchase ID is detected after reload',async()=>{
 const f=fixture(),{store}=await reserved(f),raw=JSON.parse(f.disk.get(KEYS.data));raw.deals[0].purchaseId='p-00000000-0000-4000-8000-888888888888';f.disk.set(KEYS.data,JSON.stringify(raw));assert.equal(f.make().inspect().kind,'recovery');
});
test('auxiliary failure warns separately and never rolls back saved business data',async()=>{
 const f=fixture(),a=f.make();await a.initialize();f.setFailure(KEYS.backup);const result=await a.update({type:'reserve',itemId:'dummy-stock-1'},{backup:true});assert.equal(result.kind,'applied');assert.match(result.warning,/業務データは保存済み/);assert.equal(a.inspect().data.deals.length,1);assert.equal(a.inspect().data.rev,1);
});
test('two buyer edits using the same version do not silently overwrite',async()=>{
 const f=fixture(),a=f.make(),b=f.make();await a.initialize();const input={id:'dummy-buyer',expectedVersion:0,label:'ダミー購入者'};const results=await Promise.all([a.updateBuyer(input),b.updateBuyer(input)]);assert.deepEqual(results.map(x=>x.kind).sort(),['applied','changed']);assert.equal(a.readBuyer().records[0].version,1);
});
test('backup metadata merges both fields under the shared lock',async()=>{
 const f=fixture(),a=f.make(),b=f.make();await a.initialize();await Promise.all([a.updateBackup('buyer'),b.updateBackup('transaction')]);const meta=JSON.parse(f.disk.get(KEYS.backup));assert.equal(meta.rev,2);assert.ok(meta.buyer);assert.ok(meta.transaction);
});
test('reset removes only four explicitly named lab keys and keeps unrelated data',async()=>{
 const f=fixture(),a=f.make();await a.initialize();await a.updateBackup('buyer');await a.reset();assert.deepEqual(f.removals.sort(),Object.values(KEYS).sort());assert.equal(f.disk.get('unrelated-sentinel'),'KEEP');
});
test('browser files have isolated keys, no request APIs, and a restrictive policy',()=>{
 const root=path.join(__dirname,'..'),script=fs.readFileSync(path.join(root,'commit-core.js'),'utf8'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
 assert.ok(Object.values(KEYS).every(k=>k.startsWith('lockLab_v1_')));for(const text of [script,html]){assert.doesNotMatch(text,/coupon_sales_release_rc2/);assert.doesNotMatch(text,/localStorage\s*\.\s*clear\s*\(/);assert.doesNotMatch(text,/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);}
 assert.match(html,/connect-src 'none'/);assert.match(html,/form-action 'none'/);assert.match(html,/noindex,nofollow/);
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);assert.equal(new Set(ids).size,ids.length);for(const match of script.matchAll(/\$\('([^']+)'\)/g))assert.ok(ids.includes(match[1]),'HTML missing '+match[1]);
});
