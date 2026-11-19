const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
const KEY='coupon_sales_release_rc2',BUYER='coupon_sales_release_rc2_registry_v1',META='coupon_sales_release_rc2_backup_evidence_v1';
function inventory(){
 const templates={normal:'通常ダミー',repeat:'再来ダミー',regular:'常連ダミー',closing:'締めダミー'};
 const items=['available','reserved','sent'].map((status,i)=>({id:'https://example.invalid/old-'+i,product:'既存ダミー',store:'famima',status,dealId:i?'deal-'+i:null}));
 const deals=items.slice(1).map((x,i)=>({id:x.dealId,label:'既存取引'+i,product:x.product,store:x.store,itemIds:[x.id],greetingSnapshot:{kind:'normal',greeting:'確定済みダミー',closing:'既存締め'},parts:[{ids:[x.id],messageSnapshot:'固定文面ダミー',copyIntentAt:i?'2026-11-01T00:00:00Z':null,sentAt:i?'2026-11-01T00:01:00Z':null}]}));
 return {version:3,items,deals,seq:2,lastOps:{'既存ダミー|famima':'既存操作'},templates};
}
function boot({corrupt=false}={}){
 const ledger={schema:'coupon-buyer-ledger-rc2-v1',records:[{id:'buyer-dummy',prefix:'abc',fullId:'test-id',displayName:'購入者ダミー',alias:'テスト',kind:'normal',rating:'unknown',note:'ダミーのみ',updatedAt:'2026-11-01T00:00:00Z'}]};
 const disk=new Map([[KEY,corrupt?'{broken':JSON.stringify(inventory())],[BUYER,JSON.stringify(ledger)]]),before=new Map(disk),writes=[],nodes=new Map(),requests=[];
 class Element{constructor(){this.value='';this.children=[];this.dataset={};this.style={};this.listeners={};this.classList={add(){},remove(){},toggle(){}}}addEventListener(k,f){this.listeners[k]=f}querySelectorAll(){return []}querySelector(){return new Element()}replaceChildren(...n){this.children=n}append(...n){this.children.push(...n)}setAttribute(){}remove(){}before(){}focus(){}}
 const get=id=>{if(!nodes.has(id)){const e=new Element();if(id==='editGreetingKind')e.value='normal';nodes.set(id,e)}return nodes.get(id)};
 const window={addEventListener(){}};
 const ctx=vm.createContext({window,document:{getElementById:get,querySelectorAll:()=>[],createElement:()=>new Element(),createTextNode:s=>s,body:new Element()},localStorage:{getItem:k=>disk.get(k)??null,setItem:(k,v)=>{writes.push(k);disk.set(k,v)}},URL,Map,Set,Date,structuredClone,setTimeout,clearTimeout,AbortController,console,crypto:require('node:crypto').webcrypto,requestAnimationFrame(){},confirm(){throw Error('Unexpected confirmation')},fetch:async(...args)=>{requests.push(args);throw Error('Unexpected network')}});
 for(let i=0;i<scripts.length;i++){
  let script=scripts[i];if(i===scripts.length-1){const end=script.lastIndexOf('})();');script=script.slice(0,end)+'window.__state={db,buyers,blocked,buyerBlocked,persist,strictCheck,backupSchema:BACKUP_SCHEMA,buyerSchema:BUYER_SCHEMA};'+script.slice(end);}
  vm.runInContext(script,ctx);
 }
 return {state:window.__state,disk,before,writes,requests,nodes};
}
test('existing available/reserved/sent inventory and locked messages load without rewrites',()=>{
 const c=boot();assert.equal(c.state.blocked,false);assert.deepEqual(JSON.parse(JSON.stringify(c.state.db)),inventory());assert.equal(c.disk.get(KEY),c.before.get(KEY));assert.ok(!c.writes.includes(KEY));assert.equal(c.requests.length,0);
});
test('buyer ledger and both backup schemas retain existing identities',()=>{
 const c=boot();assert.equal(c.state.buyerBlocked,false);assert.equal(JSON.stringify(c.state.buyers),c.before.get(BUYER));assert.ok(!c.writes.includes(BUYER));assert.equal(c.state.backupSchema,'coupon-sales-release-rc2-v1');assert.equal(c.state.buyerSchema,'coupon-buyer-ledger-rc2-v1');assert.ok(c.writes.every(k=>k===META));
});
test('corrupt saved inventory remains untouched and rejects writes',()=>{
 const c=boot({corrupt:true});assert.equal(c.state.blocked,true);assert.throws(()=>c.state.persist(inventory()));assert.equal(c.disk.get(KEY),'{broken');assert.ok(!c.writes.includes(KEY));assert.equal(c.requests.length,0);
});
test('keys cannot be sent to test Worker or arbitrary HTTPS hosts',()=>{
 const relay=html.slice(html.indexOf('const KenshoRelay = (()=>{'),html.indexOf('\nconst relayInbox=KenshoRelay.mount('));const api=vm.runInNewContext(relay+';KenshoRelay',{URL});
 assert.match(html, /id="relayBase"[^>]*value="https:\/\/kensho-relay\.coupon-relay-hub\.workers\.dev"/);
 assert.equal(api.baseURL('https://kensho-relay.coupon-relay-hub.workers.dev'),'https://kensho-relay.coupon-relay-hub.workers.dev');
 for(const raw of ['https://kensho-relay.8tgnaba5thaga.workers.dev','https://kensho-relay-phase2-test.coupon-relay-hub.workers.dev','https://attacker.invalid','https://kensho-relay.coupon-relay-hub.workers.dev.attacker.invalid','https://kensho-relay.coupon-relay-hub.workers.dev/?key=oops'])assert.throws(()=>api.baseURL(raw));
});

