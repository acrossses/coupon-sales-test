const {test}=require('node:test'),assert=require('node:assert/strict');
const {boot,html,KEYS,Locks,inventory}=require('./storage-harness.cjs');
const exportsToCheck=[['backupExport','transaction','backupStatus'],['buyerExport','buyer','buyerBackupStatus']];
const meta=()=>({buyer:{createdAt:null,confirmedAt:null,pending:false},transaction:{createdAt:null,confirmedAt:null,pending:false},firstActive:{buyer:null,transaction:null}});

for(const [button,type,status]of exportsToCheck){
 test(button+': share is invoked synchronously, before any await or auxiliary lock wait',async()=>{
  let resolveShare,release;const locks=new Locks();const held=locks.request(KEYS.meta+':write',{},()=>new Promise(r=>release=r));await Promise.resolve();
  const c=boot({locks,share:()=>new Promise(r=>resolveShare=r)});const pending=c.click(button);
  assert.deepEqual(c.order,['share']);assert.equal(c.api.backupMeta[type].pending,false);assert.equal(locks.calls.length,1);
  resolveShare();await Promise.resolve();assert.equal(c.order[0],'share');release();await held;await pending;
  assert.ok(c.api.backupMeta[type].createdAt);assert.equal(c.api.backupMeta[type].pending,true);assert.equal(c.api.backupMeta[type].confirmedAt,null);assert.match(c.get(status).textContent,/保存完了を確認してから/);
 });
 test(button+': sharing does not confirm a file; only explicit confirmation changes confirmedAt',async()=>{
  const c=boot({share:()=>Promise.resolve()});await c.click(button);assert.equal(c.api.backupMeta[type].confirmedAt,null);await c.api.confirmBackupSaved(type);assert.ok(c.api.backupMeta[type].confirmedAt);assert.equal(c.api.backupMeta[type].pending,false);
 });
 test(button+': cancellation, rejection and synchronous throw preserve prior evidence',async()=>{
  for(const kind of ['AbortError','NotAllowedError','throw']){
   const before=meta();before[type]={createdAt:'2026-11-01T00:00:00.000Z',confirmedAt:'2026-11-01T00:01:00.000Z',pending:false};const raw=JSON.stringify(before);
   const c=boot({disk:new Map([[KEYS.meta,raw]]),share(){const err=Object.assign(Error('simulated'),{name:kind==='throw'?'NotAllowedError':kind});if(kind==='throw')throw err;return Promise.reject(err);}});
   await c.click(button);assert.equal(c.disk.get(KEYS.meta),raw);assert.equal(c.writes.length,0);assert.match(c.get(status).textContent,/記録は更新していません/);assert.equal(c.api.backupMeta[type].pending,false);
  }
 });
 test(button+': first cancelled attempt does not create confirmation evidence',async()=>{
  const c=boot({share:()=>Promise.reject(Object.assign(Error('cancel'),{name:'AbortError'}))});await c.click(button);assert.equal(c.disk.has(KEYS.meta),false);assert.equal(c.api.backupMeta[type].pending,false);assert.equal(c.api.backupMeta[type].confirmedAt,null);
 });
 test(button+': auxiliary failure after successful handoff preserves business data and warns separately',async()=>{
  const disk=new Map([[KEYS.data,JSON.stringify(inventory())]]),c=boot({disk,share:()=>Promise.resolve(),fail:key=>key===KEYS.meta});await c.locks.idle();const before=disk.get(KEYS.data);await c.click(button);
  assert.equal(disk.get(KEYS.data),before);assert.match(c.get('storagePlanMessage').textContent,/補助情報の保存だけ失敗/);assert.match(c.get(status).textContent,/補助情報の記録には失敗/);assert.equal(c.api.backupMeta[type].pending,false);assert.equal(c.api.backupMeta[type].confirmedAt,null);
 });
 test(button+': download is initiated before evidence; failed initiation does not claim a backup',async()=>{
  for(const fails of [false,true]){
   const c=boot();c.api.setDownloadSpy(()=>{c.order.push('download');if(fails)throw Error('simulated download failure');});const pending=c.click(button);assert.equal(c.order[0],'download');await pending;
   if(fails){assert.equal(c.disk.has(KEYS.meta),false);assert.equal(c.api.backupMeta[type].pending,false);}else{assert.equal(c.api.backupMeta[type].pending,true);assert.equal(c.api.backupMeta[type].confirmedAt,null);}
  }
 });
}

test('both export handlers have no await before navigator.share call',()=>{
 for(const [button,next]of [['backupExport','// 完全一致を最優先。'],['buyerExport',"$('buyerImport').addEventListener"]]){
  const begin=html.indexOf("$('"+button+"').addEventListener('click',async()=>{");const body=html.slice(begin,html.indexOf(next,begin));const call=body.indexOf('navigator.share({files:[file]})');assert.ok(call>0);assert.doesNotMatch(body.slice(0,call),/\bawait\b/);assert.ok(body.indexOf('markBackupCreated(')>call);
 }
});

test('acknowledgement and relay input/forget cannot re-enable controls when readonly or stale',()=>{
 for(const mode of ['readonly','stale','enabled']){
  const c=boot({unsupported:mode==='readonly'});if(mode==='stale'){c.disk.set(KEYS.data,JSON.stringify(inventory()));c.events.storage({key:KEYS.data});}
  c.api.setRegistration();c.click('reviewUrls');const ack=c.get('registrationReview').children[1].children[0];ack.checked=true;ack.listeners.change();assert.equal(c.get('commitUrls').disabled,mode!=='enabled');
  c.get('relayKey').listeners.input();assert.equal(c.get('relayFetch').disabled,mode!=='enabled');c.click('relayForget');assert.equal(c.get('relayFetch').disabled,mode!=='enabled');
 }
});

test('backup evidence rendering never enables confirmation buttons after stop',async()=>{
 for(const mode of ['readonly','stale']){
  const data=meta();data.buyer.pending=true;data.transaction.pending=true;const c=boot({disk:new Map([[KEYS.meta,JSON.stringify(data)]]),unsupported:mode==='readonly'});
  if(mode==='stale'){c.disk.set(KEYS.data,JSON.stringify(inventory()));c.events.storage({key:KEYS.data});}
  c.click('reviewUrls');assert.equal(c.get('buyerConfirmSaved').disabled,true);assert.equal(c.get('transactionConfirmSaved').disabled,true);
  if(mode==='stale'){await c.api.saveBackupMeta(next=>{next.buyer.pending=true;});assert.equal(c.get('buyerConfirmSaved').disabled,true);}
 }
});

test('a fetch completing after a conflict keeps fetch disabled and does not populate new actions',async()=>{
 let resolve;const c=boot({fetcher:()=>new Promise(r=>resolve=r)});c.get('relayBase').value='https://kensho-relay.coupon-relay-hub.workers.dev';c.get('relayKey').value='dummy';const pending=c.click('relayFetch');
 c.disk.set(KEYS.data,JSON.stringify(inventory()));c.events.storage({key:KEYS.data});resolve({ok:true,json:async()=>({ok:true,items:[]})});await pending;assert.equal(c.get('relayFetch').disabled,true);assert.equal(c.get('relayItems').children.length,0);
});

test('read-only fetch handler refuses even a directly invoked stale callback',async()=>{
 const c=boot({unsupported:true});await c.click('relayFetch');assert.equal(c.requests.length,0);assert.equal(c.get('relayFetch').disabled,true);
});

test('recovered notification callback stops after a conflict without any POST',async()=>{
 const data=inventory();const incoming={id:'00000000-0000-4000-8000-000000000001',url:data.items[0].id,product:data.items[0].product,store:'famima',campaign:'ダミー',status:'pending'};
 const c=boot({disk:new Map([[KEYS.data,JSON.stringify(data)]]),fetcher:async()=>({ok:true,json:async()=>({ok:true,items:[incoming]})})});await c.locks.idle();c.get('relayBase').value='https://kensho-relay.coupon-relay-hub.workers.dev';c.get('relayKey').value='dummy';await c.click('relayFetch');
 const ack=c.get('relayItems').children[0].children.find(x=>x.textContent==='保存済み：完了通知を再送');assert.ok(ack);data.seq++;c.disk.set(KEYS.data,JSON.stringify(data));c.events.storage({key:KEYS.data});assert.equal(ack.disabled,true);await ack.listeners.click();assert.equal(c.requests.filter(x=>x[1]?.method==='POST').length,0);
});
