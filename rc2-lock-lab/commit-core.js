(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else {root.LockLabCore=api;if(typeof document!=='undefined')api.mount(document,root);}
})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const KEYS=Object.freeze({data:'lockLab_v1_data',guard:'lockLab_v1_guard',buyers:'lockLab_v1_buyers',backup:'lockLab_v1_backup'});
 const LOCK='lockLab_v1_write';
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
 const clone=x=>JSON.parse(JSON.stringify(x));
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 class Rejected extends Error{}
 const ensure=(test,message)=>{if(!test)throw new Rejected(message);};
 const validId=(value,prefix)=>typeof value==='string'&&value.startsWith(prefix)&&uuid.test(value.slice(prefix.length));
 function validate(data,guard){
  ensure(data&&data.schema===1&&Number.isSafeInteger(data.rev)&&data.rev>=0,'保存形式・版番号が不正');
  ensure(guard&&guard.schema===1&&uuid.test(guard.datasetId)&&data.datasetId===guard.datasetId&&data.historyExt?.v===1,'識別情報が欠落');
  ensure(guard.identities&&typeof guard.identities==='object'&&!Array.isArray(guard.identities),'識別対応表が不正');
  ensure(Array.isArray(data.items)&&data.items.length<=200&&Array.isArray(data.deals)&&data.deals.length<=200,'件数が不正');
  const items=new Map(),deals=new Map(),purchases=new Set();
  for(const item of data.items){ensure(typeof item.id==='string'&&/^dummy-stock-[a-z0-9-]+$/.test(item.id)&&!items.has(item.id)&&['available','reserved','sent'].includes(item.status),'在庫が不正');items.set(item.id,item);}
  for(const deal of data.deals){
   ensure(validId(deal.id,'d-')&&validId(deal.purchaseId,'p-')&&!deals.has(deal.id)&&!purchases.has(deal.purchaseId)&&guard.identities[deal.id]===deal.purchaseId,'取引IDの欠落・変更');purchases.add(deal.purchaseId);
   ensure(Array.isArray(deal.parts)&&deal.parts.length===1,'ラボの分割数が不正');
   const part=deal.parts[0],item=items.get(part.itemId);
   ensure(item&&item.dealId===deal.id,'取引と在庫が不整合');
   ensure(part.sentAt===null||typeof part.sentAt==='string'&&Number.isFinite(Date.parse(part.sentAt)),'送付日時が不正');
   ensure(part.copyIntentAt===null||typeof part.copyIntentAt==='string'&&Number.isFinite(Date.parse(part.copyIntentAt)),'コピー日時が不正');
   ensure(part.messageSnapshot===null||typeof part.messageSnapshot==='string'&&part.messageSnapshot.startsWith('ダミー文面 '),'文面が不正');
   ensure((part.copyIntentAt===null)===(part.messageSnapshot===null),'コピー準備と固定文面が不整合');
   ensure(!part.sentAt||part.copyIntentAt&&part.messageSnapshot,'未準備の送付');
   ensure(item.status===(part.sentAt?'sent':'reserved'),'在庫状態が不整合');
   const h=part.history;
   if(!h||Array.isArray(h)||!['pending','recorded'].includes(h.state)||h.state==='pending'&&h.recordedAt!==null||h.state==='recorded'&&(!part.sentAt||typeof h.recordedAt!=='string'||!Number.isFinite(Date.parse(h.recordedAt))))part.history={state:'pending',recordedAt:null};
   deals.set(deal.id,deal);
  }
  for(const item of items.values())ensure(item.status==='available'?item.dealId===null:deals.has(item.dealId),'在庫の取引参照が不正');
  return data;
 }
 function createStore({storage,locks,randomUUID=()=>crypto.randomUUID(),now=()=>new Date().toISOString(),unavailable=()=>false,failWrite=()=>false}={}){
  const canLock=()=>!unavailable()&&!!locks&&typeof locks.request==='function';
  const read=key=>{ensure(Object.values(KEYS).includes(key),'許可外キー');const raw=storage.getItem(key);return raw===null?null:JSON.parse(raw);};
  const write=(key,value)=>{ensure(Object.values(KEYS).includes(key),'許可外キー');if(failWrite(key))throw Error('模擬保存失敗');storage.setItem(key,JSON.stringify(value));};
  function inspect(){
   try{const guard=read(KEYS.guard),data=read(KEYS.data);if(!guard&&!data)return {kind:'empty'};return {kind:canLock()?'ready':'readonly',data:validate(data,guard)};}
   catch{return {kind:'recovery',message:'復旧待ち：保存データと識別情報を確認してください。新しいIDは作りません。'};}
  }
  async function locked(callback){
   if(!canLock())return {kind:'readonly',message:'ロック非対応：保存されていません。閲覧専用です。'};
   try{return await locks.request(LOCK,{mode:'exclusive'},callback);}catch(error){return error instanceof Rejected?{kind:'rejected',message:'拒否：'+error.message}:{kind:'failed',message:'保存失敗：成功とは扱いません。'};}
  }
  function fresh(){return validate(read(KEYS.data),read(KEYS.guard));}
  function initial(){return {schema:1,rev:0,datasetId:randomUUID(),historyExt:{v:1},items:[{id:'dummy-stock-1',status:'available',dealId:null}],deals:[]};}
  async function initialize(){return locked(()=>{
   const existing=inspect();if(existing.kind!=='empty')return existing;
   const data=initial();write(KEYS.guard,{schema:1,datasetId:data.datasetId,identities:{}});write(KEYS.data,data);
   return {kind:'applied',data:clone(data),message:'ダミー在庫1件を準備しました。'};
  });}
  async function reset(){return locked(()=>{
   // Only these four named laboratory keys are removable.
   for(const key of Object.values(KEYS))storage.removeItem(key);
   const data=initial();write(KEYS.guard,{schema:1,datasetId:data.datasetId,identities:{}});write(KEYS.data,data);
   return {kind:'applied',data:clone(data),message:'ラボのダミーだけを初期化しました。'};
  });}
  function reduce(data,intent){
   const deal=()=>data.deals.find(d=>d.id===intent.dealId);
   if(intent.type==='reserve'){
    const item=data.items.find(x=>x.id===intent.itemId);
    if(!item||item.status!=='available'||intent.expectedRev!==undefined&&data.rev!==intent.expectedRev)return {kind:'changed',message:'変更あり：最新の在庫を見て再確認してください。'};
    const id='d-'+randomUUID(),purchaseId='p-'+randomUUID();item.status='reserved';item.dealId=id;
    data.deals.push({id,purchaseId,parts:[{itemId:item.id,copyIntentAt:null,messageSnapshot:null,sentAt:null,history:{state:'pending',recordedAt:null}}]});
   }else if(intent.type==='register'){
    ensure(/^dummy-stock-[a-z0-9-]+$/.test(intent.itemId),'ダミーIDが不正');
    if(data.items.some(x=>x.id===intent.itemId))return {kind:'unchanged',message:'同じダミーは登録済みです。'};
    data.items.push({id:intent.itemId,status:'available',dealId:null});
   }else if(intent.type==='prepare'){
    const d=deal();ensure(d&&d.purchaseId===intent.purchaseId,'対象取引が変わりました');const p=d.parts[0];ensure(!p.sentAt,'送付済みです');
    if(p.messageSnapshot&&p.copyIntentAt)return {kind:'unchanged',message:'固定済みの同じ文面を再利用します。',text:p.messageSnapshot};
    p.copyIntentAt=now();p.messageSnapshot='ダミー文面 '+d.id;
   }else if(intent.type==='sent'){
    const d=deal();ensure(d&&d.purchaseId===intent.purchaseId,'対象取引が変わりました');const p=d.parts[0];
    if(p.sentAt)return {kind:'unchanged',message:'送付確認は記録済みです。'};
    ensure(p.copyIntentAt&&p.messageSnapshot,'先に文面を準備してください');p.sentAt=now();p.history={state:'pending',recordedAt:null};data.items.find(x=>x.id===p.itemId).status='sent';
   }else if(intent.type==='receipt'){
    const d=deal();ensure(d&&d.purchaseId===intent.purchaseId,'同期対象の識別情報が変わりました');const p=d.parts[0];ensure(p.sentAt&&p.sentAt===intent.sentAt,'同期対象の内容が変わりました');
    if(p.history.state==='recorded')return {kind:'unchanged',message:'受付は記録済みです。'};
    p.history={state:'recorded',recordedAt:now()};
   }else if(intent.type==='rewriteIdentity'){
    const d=deal();ensure(d,'対象取引なし');d.purchaseId=intent.purchaseId;
   }else throw Error('未対応の操作');
   return {kind:'applied',text:intent.type==='prepare'?deal().parts[0].messageSnapshot:undefined};
  }
  async function update(intent,{backup=false}={}){return locked(()=>{
   const state=inspect();if(state.kind!=='ready')return state;
   const data=state.data,result=reduce(data,intent);
   if(result.kind!=='applied')return {...result,data:clone(data)};
   const guard=read(KEYS.guard),expanded=clone(guard);let added=false;
   for(const d of data.deals){if(!Object.hasOwn(guard.identities,d.id)){expanded.identities[d.id]=d.purchaseId;added=true;}else ensure(guard.identities[d.id]===d.purchaseId,'取引IDの書き換え禁止');}
   data.rev++;validate(data,expanded);
   // A monotonic witness is saved first. An unused identity after a failed data
   // write is harmless; missing/changed identities after a reload are not.
   if(added)write(KEYS.guard,expanded);
   write(KEYS.data,data);
   let warning='';
   if(backup)try{const meta=read(KEYS.backup)||{rev:0};write(KEYS.backup,{...meta,rev:meta.rev+1,transaction:now()});}catch{warning='業務データは保存済み。補助情報の保存だけ失敗しました。';}
   return {...result,data:clone(data),warning,message:warning||'適用：保存が完了しました。'};
  });}
  async function updateBuyer({id,expectedVersion=0,label}){return locked(()=>{
   ensure(id==='dummy-buyer','ラボの購入者だけ操作できます');ensure(label==='ダミー購入者','ダミー以外は不可');
   const ledger=read(KEYS.buyers)||{rev:0,records:[]};ensure(Number.isSafeInteger(ledger.rev)&&Array.isArray(ledger.records),'台帳が不正');
   const old=ledger.records.find(x=>x.id===id);if((old?.version||0)!==expectedVersion)return {kind:'changed',message:'変更あり：台帳を再確認してください。'};
   const record={id,label,version:expectedVersion+1};ledger.records=ledger.records.filter(x=>x.id!==id).concat(record);ledger.rev++;write(KEYS.buyers,ledger);return {kind:'applied',message:'ダミー台帳を保存しました。'};
  });}
  async function updateBackup(type){return locked(()=>{
   ensure(['buyer','transaction'].includes(type),'補助情報の対象が不正');const meta=read(KEYS.backup)||{rev:0};ensure(Number.isSafeInteger(meta.rev),'補助情報が不正');meta[type]=now();meta.rev++;write(KEYS.backup,meta);return {kind:'applied',message:'補助情報を保存しました。'};
  });}
  function copyText(identity){
   const state=inspect();ensure(state.kind==='ready','最新状態を確認できません');const d=state.data.deals.find(x=>x.id===identity.dealId);
   ensure(d&&d.purchaseId===identity.purchaseId,'コピー対象が変わりました');const p=d.parts[0];ensure(!p.sentAt&&p.copyIntentAt&&p.messageSnapshot,'未送信の固定文面がありません');return p.messageSnapshot;
  }
  async function hold(ms){ensure([0,500,2000,5000].includes(ms),'待ち時間が不正');return locked(async()=>{await sleep(ms);return {kind:'unchanged'};});}
  async function confirmOutside(intent,confirm){const yes=await confirm();return yes?update(intent):{kind:'unchanged',message:'確認を中止しました。'};}
  function simulateLegacy(){const data=fresh();delete data.datasetId;delete data.historyExt;for(const d of data.deals)delete d.purchaseId;write(KEYS.data,data);return inspect();}
  return {inspect,initialize,reset,update,updateBuyer,updateBackup,copyText,hold,confirmOutside,simulateLegacy,readBuyer:()=>clone(read(KEYS.buyers)||{rev:0,records:[]})};
 }
 function mount(doc,win){
  const $=id=>doc.getElementById(id);if(!$('labStatus'))return;
  let store,prepared=null,channel=null,confirmResolve=null,raceResults=[];
  const report=(message)=>{$('labStatus').textContent=message;};
  const log=text=>{$('labLog').textContent=(new Date().toLocaleTimeString('ja-JP')+' '+text+'\n'+$('labLog').textContent).slice(0,6000);};
  function display(result){report(result.message||result.kind);log(result.message||result.kind);render();return result;}
  function render(){
   const state=store.inspect();$('state').textContent=state.kind==='ready'||state.kind==='readonly'?JSON.stringify(state.data,null,2):state.message||'初期化が必要です。';
   const old=$('deal').value;const deals=state.data?.deals||[];$('deal').replaceChildren(...deals.map(d=>{const o=doc.createElement('option');o.value=d.id;o.textContent=d.id.slice(0,12)+' / '+(d.parts[0].sentAt?'送付済み':'未送信');return o;}));if(deals.some(d=>d.id===old))$('deal').value=old;
   for(const node of doc.querySelectorAll('[data-write]'))node.disabled=state.kind!=='ready';
   $('labMode').textContent=state.kind==='ready'?'ダミー専用・編集可能':state.message||'閲覧専用';
  }
  const identity=()=>{const state=store.inspect(),d=state.data?.deals.find(x=>x.id===$('deal').value);ensure(d,'先にダミーを確保してください');return {dealId:d.id,purchaseId:d.purchaseId,sentAt:d.parts[0].sentAt};};
  const reserveIntent=()=>{const state=store.inspect(),item=state.data?.items.find(x=>x.status==='available');ensure(item,'利用可能なダミーがありません');return {type:'reserve',itemId:item.id,expectedRev:state.data.rev};};
  const run=callback=>async()=>{try{await callback();}catch(e){report(e.message);log(e.message);render();}};
  const bind=(id,callback)=>$(id).addEventListener('click',run(callback));
  try{store=createStore({storage:win.localStorage,locks:win.navigator.locks,randomUUID:()=>win.crypto.randomUUID(),unavailable:()=>$('noLocks').checked,failWrite:key=>$('failWrite').checked||key===KEYS.backup&&$('failBackup').checked});}catch{report('保存領域にアクセスできません。');return;}
  bind('initialize',()=>store.initialize().then(display));
  bind('reset',async()=>{if(win.confirm('このラボのダミーデータ4キーだけを初期化しますか？')){prepared=null;display(await store.reset());}});
  bind('reserve',async()=>display(await store.update(reserveIntent(),{backup:true})));
  bind('register',async()=>display(await store.update({type:'register',itemId:'dummy-stock-'+win.crypto.randomUUID()})));
  bind('sent',async()=>display(await store.update({type:'sent',...identity()})));
  bind('receipt',async()=>{const target=identity();report('模擬応答を500ms待っています（ロック外）。');await sleep(500);display(await store.update({type:'receipt',...target}));});
  async function prepare(){const target=identity(),ms=Number($('wait').value),start=Date.now();const blocker=store.hold(ms);const result=await store.update({type:'prepare',...target});await blocker;display(result);ensure(['applied','unchanged'].includes(result.kind),'準備できませんでした');prepared=target;$('copyText').value=store.copyText(prepared);return {wait:Date.now()-start};}
  bind('copyOne',async()=>{const result=await prepare();try{await win.navigator.clipboard.writeText(store.copyText(prepared));report('1ボタン：コピー成功（実測待ち '+result.wait+'ms）。');}catch{report('1ボタン：コピーできませんでした。2ボタン方式を試してください（実測待ち '+result.wait+'ms）。');}log($('labStatus').textContent);});
  bind('prepare',async()=>{const result=await prepare();report('準備済み。次に②コピーをタップしてください（実測待ち '+result.wait+'ms）。');});
  // This comparison calls the clipboard API directly in a fresh user gesture.
  // It checks current storage synchronously; it does not await a lock first.
  bind('copyTwo',async()=>{ensure(prepared,'先に①文面を準備してください');const text=store.copyText(prepared);await win.navigator.clipboard.writeText(text);report('2ボタン：コピー成功。下の貼付欄で文面を確認してください。');log('2ボタン：コピー成功');});
  bind('dialog',async()=>{const intent=reserveIntent();$('confirmText').textContent='この確認を開いたまま、別タブで在庫を変更できます。確認後に最新版を再検証します。';$('confirmDialog').showModal();display(await store.confirmOutside(intent,()=>new Promise(resolve=>{confirmResolve=resolve;})));});
  for(const [id,value] of [['confirmYes',true],['confirmNo',false]])$(id).addEventListener('click',()=>{$('confirmDialog').close();const done=confirmResolve;confirmResolve=null;done?.(value);});
  $('confirmDialog').addEventListener('cancel',event=>{event.preventDefault();$('confirmDialog').close();const done=confirmResolve;confirmResolve=null;done?.(false);});
  bind('legacy',()=>display(store.simulateLegacy()));
  bind('buyer',async()=>{const old=store.readBuyer().records.find(x=>x.id==='dummy-buyer');display(await store.updateBuyer({id:'dummy-buyer',expectedVersion:old?.version||0,label:'ダミー購入者'}));});
  bind('backup',async()=>display(await store.updateBackup('buyer')));
  bind('batch',async()=>{
   if(!win.confirm('ラボのダミーを初期化しながら、同じ在庫への競合を20回試しますか？'))return;
   let passes=0;for(let i=0;i<20;i++){const init=await store.reset();ensure(init.kind==='applied','初期化失敗');const intent=reserveIntent();const results=await Promise.all([store.update(intent),store.update(intent)]);const data=store.inspect().data;if(results.filter(x=>x.kind==='applied').length===1&&results.filter(x=>x.kind==='changed').length===1&&data.rev===1&&data.deals.length===1)passes++;}
   display({kind:'unchanged',message:'実Web Locksでの20回競合：'+passes+'/20合格（各回rev=1、2つの呼出元）。実2タブ試験は別ボタンで行ってください。'});
  });
  function connectChannel(){if(channel||typeof win.BroadcastChannel!=='function')return;
   channel=new win.BroadcastChannel('lockLab_v1_race');
   channel.onmessage=async event=>{
    const msg=event.data;
    if(msg?.type==='race'&&typeof msg.run==='string'&&msg.run.length<80&&Number.isFinite(msg.at)&&msg.at>=Date.now()-500&&msg.at<=Date.now()+5000&&msg.intent?.type==='reserve')executeRace(msg);
    if(msg?.type==='result'&&msg.run===$('raceRun').textContent&&['applied','changed','failed','readonly','recovery'].includes(msg.kind)){raceResults.push(msg.kind);$('raceResult').textContent=raceResults.join(' / ');}
   };
  }
  connectChannel();
  async function executeRace(msg){$('raceRun').textContent=msg.run;raceResults=[];await sleep(Math.max(0,msg.at-Date.now()));let result;try{result=await store.update(msg.intent);}catch{result={kind:'failed'};}display(result);raceResults.push(result.kind);$('raceResult').textContent=raceResults.join(' / ');channel?.postMessage({type:'result',run:msg.run,kind:result.kind});}
  bind('race',async()=>{ensure(channel,'このブラウザでは2タブ試験に対応していません');const msg={type:'race',run:win.crypto.randomUUID(),at:Date.now()+1500,intent:reserveIntent()};channel.postMessage(msg);executeRace(msg);});
  for(const id of ['noLocks','failWrite','failBackup'])$(id).addEventListener('change',()=>{render();report('模擬設定を更新しました。');});
  win.addEventListener('storage',event=>{if(Object.values(KEYS).includes(event.key))render();});
  win.addEventListener('pageshow',()=>{connectChannel();render();});win.addEventListener('pagehide',()=>{confirmResolve?.(false);confirmResolve=null;channel?.close();channel=null;});
  render();const initial=store.inspect();report(initial.kind==='empty'?'①ダミーを準備を押してください。通信・本番キーは使いません。':initial.kind==='ready'?'保存済みのラボデータを読み込みました。':initial.message||'閲覧専用です。');
 }
 return {KEYS,LOCK,createStore,validate,mount};
});
