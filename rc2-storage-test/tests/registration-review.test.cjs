const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const handler=html.slice(html.indexOf("$('commitUrls').addEventListener('click',async()=>{"),html.indexOf('\nconst BACKUP_SCHEMA='));
const verify=html.slice(html.indexOf('function verifyPreview(){'),html.indexOf('\nfunction resetRegistrationReview(){'));
function setup(){
 let callback,answer;
 const fields={urlInput:{value:'https://example.invalid/test'},newProduct:{value:'TEST'},checkSummary:{textContent:''}};
 const line={line:1,value:fields.urlInput.value,store:'famima'},selections=[{x:line,store:'famima'}];
 const db={items:[],deals:[],lastOps:{}};
 const preview={product:'TEST',raw:line.value,dbStamp:'[]',reviewed:{ack:true,fingerprint:JSON.stringify([[1,line.value,'famima']])}};
 const state={db,preview,blocked:false,inspected:true,writes:0,notifications:0,failSave:false};
 const ctx=vm.createContext({
  ...state,structuredClone,Error,JSON,
  $:id=>id==='commitUrls'?{addEventListener:(type,fn)=>callback=fn}:fields[id],
  window:{rc2RegistrationConfirm:()=>new Promise(r=>answer=r)},
  registrationSelections(){vm.runInContext('verifyPreview()',ctx);return selections},
  requireInspected(){if(!state.inspected)throw Error('uninspected')},
  registrationFingerprint:rows=>JSON.stringify(rows.map(({x,store})=>[x.line,x.value,store])),
  storeName:x=>x,strictCheck(next){assert.equal(new Set(next.items.map(x=>x.id)).size,next.items.length)},
  KEY:'coupon_sales_release_rc2_storagetest',storagePlan:{snapshot(){return null}},update(fn){if(state.failSave)throw Error('storage failed');const next=structuredClone(ctx.db);fn(next);state.writes++;ctx.db=next;return Promise.resolve();},
  relayInbox:{recordSaved(){state.notifications++}},
  clearRegistration(){ctx.preview=null},note(){},log(){},resetRegistrationReview(){if(ctx.preview)ctx.preview.reviewed=null}
 });
 vm.runInContext(verify+'\n'+handler,ctx);
 return {state,ctx,fields,start:()=>callback(),answer:ok=>answer(ok)};
}
test('cancel writes nothing and never notifies',async()=>{const s=setup(),p=s.start();s.answer(false);await p;assert.equal(s.state.writes,0);assert.equal(s.state.notifications,0)});
test('accept saves once before notifying',async()=>{const s=setup(),p=s.start();s.answer(true);await p;assert.equal(s.state.writes,1);assert.equal(s.state.notifications,1);assert.equal(s.ctx.db.items[0].store,'famima')});
test('changed URL during confirmation aborts before save',async()=>{const s=setup(),p=s.start();s.fields.urlInput.value+='-changed';s.answer(true);await p;assert.equal(s.state.writes,0);assert.match(s.fields.checkSummary.textContent,/登録できません/)});
test('inventory changed during confirmation aborts before save',async()=>{const s=setup(),p=s.start();s.ctx.db.items.push({id:'other'});s.answer(true);await p;assert.equal(s.state.writes,0)});
test('revoked acknowledgement during confirmation aborts before save',async()=>{const s=setup(),p=s.start();s.ctx.preview.reviewed.ack=false;s.answer(true);await p;assert.equal(s.state.writes,0)});
test('blocked storage after confirmation starts aborts before save',async()=>{const s=setup(),p=s.start();s.ctx.blocked=true;s.answer(true);await p;assert.equal(s.state.writes,0)});
test('failed storage never sends saved notification',async()=>{const s=setup(),p=s.start();s.state.failSave=true;s.answer(true);await p;assert.equal(s.state.writes,0);assert.equal(s.state.notifications,0)});

