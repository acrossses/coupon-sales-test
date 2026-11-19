// RC2 scroll-cancel regression tests. Dummy data only; no network access.
// Run: node --test rc2-scroll-test/scroll-cancel.test.cjs
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const main=scripts[scripts.length-1];
const START='const cloudConfirmStates=new Map();',END='function render(){';
const block=main.slice(main.indexOf(START),main.indexOf(END));

function confirmationEnv(){
 const nodes=[];let active;
 const make=()=>({children:[],inert:false,style:{},listeners:{},setAttribute(){},append(...n){this.children.push(...n)},addEventListener(k,f){this.listeners[k]=f},focus(){active=this},remove(){const i=body.children.indexOf(this);if(i>=0)body.children.splice(i,1)}});
 const body=make(),background=make(),status={};body.append(background);
 const window={};const document={body,get activeElement(){return active},getElementById:()=>status,createElement(){const n=make();nodes.push(n);return n}};
 vm.runInNewContext(scripts[0],{window,document,Promise});
 return {window,body,background,nodes,status};
}
test('registration confirmation cancels without accepting and restores background',async()=>{
 const e=confirmationEnv();const result=e.window.rc2RegistrationConfirm('TEST');
 assert.equal(e.background.inert,true);
 e.nodes.find(n=>n.textContent==='キャンセル').listeners.click();
 assert.equal(await result,false);assert.equal(e.background.inert,false);assert.equal(e.body.children.length,1);
});
test('registration confirmation requires explicit accept',async()=>{
 const e=confirmationEnv();const result=e.window.rc2RegistrationConfirm('TEST');
 e.nodes.find(n=>n.textContent==='確認した内容で登録する').listeners.click();
 assert.equal(await result,true);assert.equal(e.background.inert,false);
});
test('duplicate confirmation does not create a second dialog',async()=>{
 const e=confirmationEnv();const first=e.window.rc2RegistrationConfirm('TEST');
 assert.equal(await e.window.rc2RegistrationConfirm('TEST'),false);assert.equal(e.body.children.length,2);
 e.nodes.find(n=>n.textContent==='キャンセル').listeners.click();assert.equal(await first,false);
});
test('Escape cancels registration confirmation',async()=>{
 const e=confirmationEnv();const result=e.window.rc2RegistrationConfirm('TEST');
 e.body.children[1].listeners.keydown({key:'Escape',preventDefault(){}});
 assert.equal(await result,false);
});

function makeEnv(items){
 const frames=[],listeners={},scrolls=[],panels=[];
 const mkPanel=()=>({className:'',dataset:{},children:[],attrs:{},placed:null,
  addEventListener(){},setAttribute(k,v){this.attrs[k]=v},append(...c){this.children.push(...c)},
  remove(){const i=panels.indexOf(this);if(i>=0)panels.splice(i,1);this.placed=null}});
 const inventoryEl={products:[],before(p){p.placed='outside';panels.push(p)},prepend(p){p.placed='inside-top';panels.push(p)},
  querySelectorAll(sel){return sel==='.product'?this.products:[]}};
 const addCard=(product,store)=>{
  let prod=inventoryEl.products.find(p=>p.title===product);
  if(!prod){prod={title:product,stores:[],querySelector(s){return s==='.product-head h3'?{textContent:this.title}:null},
   querySelectorAll(s){return s==='.store'?this.stores:[]}};inventoryEl.products.push(prod);}
  const card={dataset:{store},scrollIntoView(o){scrolls.push({product,store,o});},
   querySelector(s){return s==='.op-history'?{after:p=>{p.placed='card:'+product+'|'+store;panels.push(p)}}:null}};
  prod.stores.push(card);return card;
 };
 const status={textContent:''};
 const env={db:{items:items.map(x=>({...x}))},frames,scrolls,panels,listeners,addCard,inventoryEl,status,now:1000000};
 const ctx={
  $:id=>id==='inventory'?inventoryEl:id==='relayStatus'?status:null,
  document:{querySelectorAll:sel=>sel==='.cloud-confirm-state'?[...panels]:[],createElement:()=>mkPanel()},
  window:{addEventListener:(ev,fn)=>{(listeners[ev]=listeners[ev]||[]).push(fn)}},
  requestAnimationFrame:fn=>{frames.push(fn)},
  storeName:s=>({seven:'SEVEN',famima:'FAMIMA'}[s]||s),
  Date:{now:()=>env.now},Map,Array,Set,
 };
 ctx.db=env.db;
 const sandbox=vm.createContext(ctx);
 vm.runInContext(block+';this.__api={setCloudConfirmState};',sandbox);
 env.api=sandbox.__api;
 env.flush=(n=1)=>{for(let i=0;i<n;i++){const f=frames.splice(0);f.forEach(fn=>fn())}};
 env.touch=()=>{(listeners.touchstart||[]).forEach(fn=>fn())};
 return env;
}
const items=[
 {id:'https://example.invalid/seven1',product:'TEST',store:'seven'},
 {id:'https://example.invalid/fami1',product:'TEST',store:'famima'},
 {id:'https://example.invalid/fami2',product:'OTHER',store:'famima'},
];
const itm=(n,url)=>({id:'r'+n,url,product:'TEST',store:'seven'}); // cloud store is deliberately 'seven'
const FAMI=itm(1,'https://example.invalid/fami1');
const SEV=itm(2,'https://example.invalid/seven1');
const FAMI2=itm(3,'https://example.invalid/fami2');
function setup(){const e=makeEnv(items);e.addCard('TEST','seven');e.addCard('TEST','famima');e.addCard('OTHER','famima');return e;}

test('inline script has valid syntax',()=>{new vm.Script(main)});

test('saved record (famima) wins over cloud store (seven)',()=>{
 const e=setup();e.api.setCloudConfirmState(FAMI,'pending');e.flush(3);
 assert.equal(e.scrolls.length,1);
 assert.deepEqual([e.scrolls[0].product,e.scrolls[0].store],['TEST','famima']);
 assert.equal(e.panels[0].placed,'card:TEST|famima');
});

test('duplicate pending of the same URL scrolls once; retry pending adds no extra scroll',()=>{
 const e=setup();e.api.setCloudConfirmState(FAMI,'pending');e.api.setCloudConfirmState(FAMI,'pending');e.flush(3);
 assert.equal(e.scrolls.length,1);
 e.api.setCloudConfirmState(FAMI,'failed',()=>{});e.flush(3);
 assert.equal(e.scrolls.length,2); // the single re-align after the list above shrinks
 e.api.setCloudConfirmState(FAMI,'pending');e.flush(3);
 assert.equal(e.scrolls.length,2);
});

test('FAIL-CASE 1: user operation after first reservation but before the frame cancels the jump',()=>{
 const e=setup();e.api.setCloudConfirmState(FAMI,'pending');
 e.flush(1);e.touch();e.flush(3);
 assert.equal(e.scrolls.length,0);
});

test('FAIL-CASE 1b: user operation between the two frames also cancels',()=>{
 const e=setup();e.api.setCloudConfirmState(FAMI,'pending');e.touch();e.flush(3);
 assert.equal(e.scrolls.length,0);
});

test('FAIL-CASE 2: user operation after re-align reservation (done) but before it runs cancels it',()=>{
 const e=setup();e.api.setCloudConfirmState(FAMI,'pending');e.flush(3);
 assert.equal(e.scrolls.length,1);
 e.api.setCloudConfirmState(FAMI,'done');e.touch();e.flush(3);
 assert.equal(e.scrolls.length,1);
});

test('re-align after done still works when the user did not touch the page',()=>{
 const e=setup();e.api.setCloudConfirmState(FAMI,'pending');e.flush(3);
 e.api.setCloudConfirmState(FAMI,'done');e.flush(3);
 assert.equal(e.scrolls.length,2);assert.equal(e.scrolls[1].store,'famima');
});

test('card not rendered yet: retry runs, then user operation during retry cancels before moving',()=>{
 const e=makeEnv(items);e.addCard('TEST','seven');
 e.api.setCloudConfirmState(FAMI,'pending');e.flush(3);
 assert.equal(e.scrolls.length,0);
 e.touch();e.addCard('TEST','famima');e.flush(6);
 assert.equal(e.scrolls.length,0);
});

test('card rendered during retry and no user operation: moves to famima only',()=>{
 const e=makeEnv(items);e.addCard('TEST','seven');
 e.api.setCloudConfirmState(FAMI,'pending');e.flush(3);
 e.addCard('TEST','famima');e.flush(3);
 assert.equal(e.scrolls.length,1);assert.equal(e.scrolls[0].store,'famima');
});

test('card never rendered: no move to another store, retries are bounded',()=>{
 const e=makeEnv(items);e.addCard('TEST','seven');
 e.api.setCloudConfirmState(FAMI,'pending');e.flush(20);
 assert.equal(e.scrolls.length,0);assert.equal(e.frames.length,0);
});

test('OLD-URL RESERVATION: moving on to another URL cancels the previous reservation',()=>{
 const e=setup();e.api.setCloudConfirmState(SEV,'pending');
 e.flush(1);
 e.api.setCloudConfirmState(FAMI2,'pending');
 e.flush(4);
 assert.equal(e.scrolls.length,1);
 assert.deepEqual([e.scrolls[0].product,e.scrolls[0].store],['OTHER','famima']);
});

test('OLD-URL RESERVATION in card-retry: previous URL retry is discarded when a new URL starts',()=>{
 const e=makeEnv(items);e.addCard('TEST','seven');e.addCard('OTHER','famima');
 e.api.setCloudConfirmState(FAMI,'pending');e.flush(3);
 e.api.setCloudConfirmState(FAMI2,'pending');e.addCard('TEST','famima');
 e.flush(6);
 assert.deepEqual(e.scrolls.map(s=>s.product+'|'+s.store),['OTHER|famima']);
});

test('late done of an old URL does not move and does not re-align',()=>{
 const e=setup();e.api.setCloudConfirmState(SEV,'pending');e.flush(3);
 e.api.setCloudConfirmState(FAMI,'pending');e.flush(3);
 const n=e.scrolls.length;
 e.api.setCloudConfirmState(SEV,'done');e.flush(3);
 assert.equal(e.scrolls.length,n);
});

test('unsaved URL: no scroll, failure panel + retry shown outside the card list',()=>{
 const e=setup();e.db.items.length=0;
 e.api.setCloudConfirmState(FAMI,'failed',()=>{});e.flush(3);
 assert.equal(e.scrolls.length,0);
 assert.equal(e.panels[0].placed,'outside');
 assert.ok(e.panels[0].children.some(c=>c.textContent==='再通知'));
});

test('state changes never mutate saved inventory records',()=>{
 const e=setup();const before=JSON.stringify(e.db.items);
 for(const st of ['pending','failed','pending','done'])e.api.setCloudConfirmState(FAMI,st,()=>{});
 e.flush(5);assert.equal(JSON.stringify(e.db.items),before);
});
