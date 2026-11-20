const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const relay=html.slice(html.indexOf('const KenshoRelay = (()=>{'),html.indexOf('\nconst relayInbox=KenshoRelay.mount('));
const item={id:'00000000-0000-0000-0000-000000000001',url:'https://example.invalid/dummy',product:'TEST',store:'famima',campaign:'TEST',status:'pending'};
class Element{constructor(){this.value='';this.children=[];this.listeners={};this.hidden=false;this.disabled=false}addEventListener(k,f){this.listeners[k]=f}async emit(k){return this.listeners[k]?.()}replaceChildren(...n){this.children=n}append(...n){this.children.push(...n)}remove(){this.removed=true}}
function client({disk=[{id:item.url,product:'TEST',store:'famima'}],incoming=item,fail=false,ackApplied=true}={}){
 const nodes=Object.fromEntries(['relayBase','relayKey','relayStatus','relayFetch','relayForget','relayItems'].map(k=>[k,new Element()]));nodes.relayBase.value='https://kensho-relay.coupon-relay-hub.workers.dev';nodes.relayKey.value='dummy';
 const requests=[],states=[];let pending=true,failNext=fail;
 const match=x=>disk.some(y=>y.id===x.url&&y.product===x.product&&(x.store==='other'?y.store.startsWith('other:'):y.store===x.store));
 const ctx=vm.createContext({URL,Response,AbortController,setTimeout,clearTimeout,document:{getElementById:k=>nodes[k],createElement:()=>new Element(),createTextNode:s=>s},window:{addEventListener(){}},fetch:async(url,opts={})=>{
  requests.push({url,opts});if(url.endsWith('/api/pending'))return Response.json({ok:true,items:pending?[incoming]:[]});
  assert.equal(opts.method,'POST');assert.deepEqual(JSON.parse(opts.body),{ids:[incoming.id],rc2Saved:true});
  if(failNext){failNext=false;throw Error('offline')};if(ackApplied)pending=false;return Response.json({ok:true});
 }});
 const api=vm.runInContext(relay+';KenshoRelay',ctx);
 const inbox=api.mount({has:url=>disk.some(y=>y.id===url),savedMatches:match,stage:()=>true,cloudConfirmState:(x,s,retry)=>states.push({s,retry})});
 return {nodes,requests,states,disk,inbox,posts:()=>requests.filter(x=>x.url.endsWith('/api/confirm')),row:()=>nodes.relayItems.children[0],retry(){return this.row().children.find(x=>x?.textContent==='保存済み：完了通知を再送')}};
}
test('reload recovery offers manual notification without writing inventory or automatically notifying',async()=>{
 const c=client(),before=JSON.stringify(c.disk);await c.nodes.relayFetch.emit('click');assert.equal(c.posts().length,0);assert.equal(c.retry().hidden,false);assert.equal(c.retry().disabled,false);
 await c.retry().emit('click');assert.equal(c.posts().length,1);assert.equal(JSON.stringify(c.disk),before);assert.equal(c.row().removed,true);
 await c.nodes.relayFetch.emit('click');assert.equal(c.nodes.relayItems.children.length,0);
});
test('failed recovered notification keeps a visible retry and inventory unchanged',async()=>{
 const c=client({fail:true}),before=JSON.stringify(c.disk);await c.nodes.relayFetch.emit('click');await c.retry().emit('click');assert.equal(c.retry().hidden,false);assert.equal(c.retry().disabled,false);assert.equal(c.row().removed,undefined);
 await c.retry().emit('click');assert.equal(c.posts().length,2);assert.equal(c.row().removed,true);assert.equal(JSON.stringify(c.disk),before);
});
for(const [label,disk,incoming] of [
 ['product mismatch',[{id:item.url,product:'OTHER',store:'famima'}],item],
 ['store mismatch',[{id:item.url,product:'TEST',store:'seven'}],item],
 ['ambiguous other store',[{id:item.url,product:'TEST',store:'other:SHOP'}],{...item,store:'other'}],
 ['URL query mismatch',[{id:item.url+'?new',product:'TEST',store:'famima'}],item]
])test(label+' never offers recovery',async()=>{const c=client({disk,incoming});await c.nodes.relayFetch.emit('click');assert.equal(c.retry(),undefined);assert.equal(c.posts().length,0)});
test('inventory removed after fetching aborts retry without notifying',async()=>{
 const c=client();await c.nodes.relayFetch.emit('click');const b=c.retry();c.disk.length=0;await b.emit('click');assert.equal(c.posts().length,0);assert.equal(b.hidden,true);
});
test('stale retry callback after refresh is rejected',async()=>{
 const c=client({fail:true});await c.nodes.relayFetch.emit('click');await c.retry().emit('click');const stale=c.states.find(x=>x.s==='failed').retry;await c.nodes.relayFetch.emit('click');await stale();assert.equal(c.posts().length,1);
});
test('forgetting credentials invalidates existing retry',async()=>{
 const c=client();await c.nodes.relayFetch.emit('click');const b=c.retry();await c.nodes.relayForget.emit('click');await b.emit('click');assert.equal(c.posts().length,0);assert.equal(c.nodes.relayKey.value,'');
});

