const {test}=require('node:test'),assert=require('node:assert/strict');
const {html,KEYS,Locks,boot,inventory,buyer}=require('./storage-harness.cjs');
const stored=data=>new Map([[KEYS.data,JSON.stringify(data)]]);
const add=id=>next=>{next.items.push({id:'https://example.invalid/'+id,product:'ダミー',store:'famima',status:'available',dealId:null});};
const row=()=>({schema:'coupon-buyer-ledger-rc2-v1',records:[buyer()]});

test('real update preserves first tab save and rejects the stale second tab',async()=>{
 const disk=stored(inventory()),locks=new Locks(),a=boot({disk,locks}),b=boot({disk,locks});await locks.idle();
 const [x,y]=await Promise.allSettled([a.api.update(add('a')),b.api.update(add('b'))]);assert.equal(x.status,'fulfilled');assert.equal(y.status,'rejected');assert.match(y.reason.message,/変更あり/);
 assert.deepEqual(JSON.parse(disk.get(KEYS.data)).items.map(x=>x.id),['https://example.invalid/one','https://example.invalid/a']);assert.equal(b.api.needsReload,true);
 const reloaded=boot({disk,locks});await reloaded.api.update(add('b'));assert.equal(JSON.parse(disk.get(KEYS.data)).items.length,3);
});
test('queued update keeps the snapshot from before the lock wait',async()=>{
 const c=boot({disk:stored(inventory())});await c.locks.idle();let release;const held=c.locks.request(KEYS.data+':write',{},()=>new Promise(r=>release=r));await Promise.resolve();
 const operation=c.api.update(add('later'));c.disk.set(KEYS.data,JSON.stringify({...inventory(),seq:10}));release();await held;await assert.rejects(operation,/変更あり/);assert.equal(JSON.parse(c.disk.get(KEYS.data)).seq,10);
});
test('same tab overlapping operations do not silently overwrite an earlier save',async()=>{
 const c=boot();const results=await Promise.allSettled([c.api.update(add('one')),c.api.update(add('two'))]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(JSON.parse(c.disk.get(KEYS.data)).items.length,1);
});
test('raw string difference, even whitespace, aborts without a persisted rev',async()=>{
 const c=boot({disk:stored(inventory())});await c.locks.idle();const changed=JSON.stringify(inventory(),null,2);c.disk.set(KEYS.data,changed);await assert.rejects(c.api.update(add('new')),/変更あり/);assert.equal(c.disk.get(KEYS.data),changed);assert.equal(Object.hasOwn(c.api.db,'rev'),false);
});
test('a rejected mutator and a failed physical write leave disk and memory unchanged',async()=>{
 let failed=false;const c=boot({disk:stored(inventory()),fail:key=>failed&&key===KEYS.data});await c.locks.idle();const before=c.disk.get(KEYS.data),memory=JSON.stringify(c.api.db);
 await assert.rejects(c.api.update(next=>{next.seq++;throw Error('reject');}),/reject/);failed=true;await assert.rejects(c.api.update(add('new')),/保存失敗/);
 assert.equal(c.disk.get(KEYS.data),before);assert.equal(JSON.stringify(c.api.db),memory);
});
test('async mutators are rejected before any write',async()=>{
 const c=boot();await assert.rejects(c.api.update(async next=>{next.seq++;}),/同期関数/);assert.equal(c.disk.has(KEYS.data),false);
});
test('primary success survives auxiliary failure with a distinct persistent warning',async()=>{
 const c=boot({fail:key=>key===KEYS.meta});await c.api.update(add('new'));await c.locks.idle();assert.equal(JSON.parse(c.disk.get(KEYS.data)).items.length,1);assert.match(c.get('storagePlanMessage').textContent,/補助情報の保存だけ失敗/);assert.equal(c.api.backupMeta.firstActive.transaction,null);
});
test('unsupported locks reject inventory, buyers, metadata and synchronous copy',async()=>{
 const c=boot({disk:stored(inventory({reserved:true})),unsupported:true});const before=new Map(c.disk);
 assert.throws(()=>c.api.update(add('no')),/閲覧専用/);await assert.rejects(c.api.saveBuyers(()=>row()),/閲覧専用/);assert.equal(await c.api.markBackupCreated('buyer'),false);
 const pending=c.click('deals',c.dealEvent('copy'));assert.equal(c.copies.length,0);await pending;assert.deepEqual(c.disk,before);
});
test('keys have separate locks and no write can target the formal storage keys',async()=>{
 const c=boot();await c.api.update(add('new'));await c.locks.idle();await c.api.saveBuyers(()=>row());await c.locks.idle();await c.api.markBackupCreated('buyer');
 for(const key of Object.values(KEYS))assert.ok(c.locks.calls.includes(key+':write'));assert.ok(c.reads.every(x=>Object.values(KEYS).includes(x)));assert.ok(c.writes.every(x=>Object.values(KEYS).includes(x)));
 assert.throws(()=>c.api.storagePlan.update('coupon_sales_release_rc2',()=>{}),/対象外/);
});
test('real registration handler saves through real update and then notifies',async()=>{
 const c=boot();const count=c.api.setRegistration();await c.click('commitUrls');assert.equal(count(),1);assert.equal(JSON.parse(c.disk.get(KEYS.data)).items[0].id,'https://example.invalid/new');assert.equal(c.writes.filter(x=>x===KEYS.data).length,1);assert.equal(c.requests.length,0);
});
test('real registration handler never notifies on storage failure or stale tab',async()=>{
 for(const stale of [false,true]){const c=boot({fail:key=>!stale&&key===KEYS.data}),count=c.api.setRegistration();if(stale)c.disk.set(KEYS.data,JSON.stringify(inventory()));await c.click('commitUrls');assert.equal(count(),0);assert.equal(c.writes.filter(x=>x===KEYS.data).length,0);assert.match(c.get('checkSummary').textContent,/登録できません/);}
});
test('confirmation waits outside the lock; change during confirmation is rejected',async()=>{
 const c=boot();let answer;c.ctx.window.rc2RegistrationConfirm=()=>new Promise(r=>answer=r);const count=c.api.setRegistration(),pending=c.click('commitUrls');assert.equal(c.locks.calls.length,0);c.disk.set(KEYS.data,JSON.stringify(inventory()));answer(true);await pending;assert.equal(count(),0);assert.match(c.get('storagePlanMessage').textContent,/変更あり/);
});
test('buyer physical save failure does not change the in-memory ledger',async()=>{
 const c=boot({fail:key=>key===KEYS.buyer});await assert.rejects(c.api.saveBuyers(()=>row()),/保存失敗/);assert.equal(c.api.buyers.records.length,0);assert.equal(c.disk.has(KEYS.buyer),false);
});
test('two buyer edits from different memories cannot overwrite each other',async()=>{
 const disk=new Map([[KEYS.buyer,JSON.stringify(row())]]),locks=new Locks(),a=boot({disk,locks}),b=boot({disk,locks});await locks.idle();await a.api.saveBuyers(next=>{next.records[0].note='ダミーA';});await assert.rejects(b.api.saveBuyers(next=>{next.records[0].note='ダミーB';}),/変更あり/);assert.equal(JSON.parse(disk.get(KEYS.buyer)).records[0].note,'ダミーA');
});
test('real buyer import restores only into empty ledger and preserves backup schema',async()=>{
 const c=boot();c.get('buyerImportFile').files=[{size:100,text:async()=>JSON.stringify(row())}];await c.click('buyerImport');assert.equal(JSON.parse(c.disk.get(KEYS.buyer)).schema,'coupon-buyer-ledger-rc2-v1');assert.equal(c.disk.has(KEYS.data),false);const writes=c.writes.filter(x=>x===KEYS.buyer).length;await c.click('buyerImport');assert.equal(c.writes.filter(x=>x===KEYS.buyer).length,writes);assert.match(c.get('buyerBackupStatus').textContent,/完全一致/);
});
test('real buyer import failure and malformed import never claim restored',async()=>{
 const c=boot({fail:key=>key===KEYS.buyer});c.get('buyerImportFile').files=[{size:100,text:async()=>JSON.stringify(row())}];await c.click('buyerImport');assert.match(c.get('buyerBackupStatus').textContent,/復元停止/);assert.equal(c.api.buyers.records.length,0);c.get('buyerImportFile').files=[{size:10,text:async()=>'{broken'}];await c.click('buyerImport');assert.equal(c.disk.has(KEYS.buyer),false);
});
test('real transaction import preserves version and does not touch buyer key',async()=>{
 const c=boot(),data=inventory();c.get('backupFile').files=[{size:100,text:async()=>JSON.stringify({schema:'coupon-sales-release-rc2-v1',exportedAt:'2026-11-01T00:00:00Z',data})}];await c.click('backupImport');assert.deepEqual(JSON.parse(c.disk.get(KEYS.data)),data);assert.equal(c.disk.has(KEYS.buyer),false);assert.equal(c.api.db.version,3);
});
test('copy invokes real storage and clipboard synchronously before its handler returns',async()=>{
 const c=boot({disk:stored(inventory({reserved:true}))});await c.locks.idle();c.order.length=0;c.locks.calls.length=0;
 const pending=c.click('deals',c.dealEvent('copy'));assert.equal(c.copies.length,1);assert.equal(c.order[0],'save:'+KEYS.data);assert.equal(c.order[1],'clipboard');assert.equal(c.locks.calls.includes(KEYS.data+':write'),false);await pending;
 const data=JSON.parse(c.disk.get(KEYS.data));assert.ok(data.deals[0].parts[0].copyIntentAt);assert.equal(c.copies[0],data.deals[0].parts[0].messageSnapshot);
});
test('clipboard failure preserves fixed message and time for synchronous retry',async()=>{
 let failed=true;const c=boot({disk:stored(inventory({reserved:true})),clipboard:()=>failed?Promise.reject(Error('denied')):Promise.resolve()});await c.locks.idle();await c.click('deals',c.dealEvent('copy'));const before=JSON.parse(c.disk.get(KEYS.data)).deals[0].parts[0];assert.match(c.get('notice').textContent,/手動でコピー/);failed=false;await c.click('deals',c.dealEvent('copy'));const after=JSON.parse(c.disk.get(KEYS.data)).deals[0].parts[0];assert.equal(after.copyIntentAt,before.copyIntentAt);assert.equal(after.messageSnapshot,before.messageSnapshot);assert.equal(c.copies.length,2);
});
test('failed copy save never reaches clipboard',async()=>{
 const c=boot({disk:stored(inventory({reserved:true})),fail:key=>key===KEYS.data});await c.locks.idle();const before=c.disk.get(KEYS.data);const pending=c.click('deals',c.dealEvent('copy'));assert.equal(c.copies.length,0);await pending;assert.equal(c.disk.get(KEYS.data),before);
});
test('copy post-save interference warns without sending clipboard or rolling data back',async()=>{
 const c=boot({disk:stored(inventory({reserved:true})),afterWrite(key,disk){if(key===KEYS.data){const value=JSON.parse(disk.get(key));value.lastOps.other='別タブのダミー';disk.set(key,JSON.stringify(value));}}});await c.locks.idle();await c.click('deals',c.dealEvent('copy'));assert.equal(c.copies.length,0);assert.equal(c.api.needsReload,true);assert.match(c.get('storagePlanMessage').textContent,/保存済みか未確定/);assert.equal(JSON.parse(c.disk.get(KEYS.data)).lastOps.other,'別タブのダミー');
});
test('storage and pageshow hints require reload, rather than silently adopting a stale edit',()=>{
 const c=boot(),changed=JSON.stringify(inventory());c.disk.set(KEYS.data,changed);c.events.storage({key:KEYS.data});assert.equal(c.api.needsReload,true);assert.equal(c.disk.get(KEYS.data),changed);c.click('storagePlanReload');assert.equal(c.reloads,1);
});
test('auxiliary save failure never updates confirmed evidence in memory',async()=>{
 const c=boot({fail:key=>key===KEYS.meta});assert.equal(await c.api.markBackupCreated('buyer'),false);assert.equal(c.api.backupMeta.buyer.pending,false);assert.equal(c.api.backupMeta.buyer.createdAt,null);
});
test('copy branch has no await before writeText; no new persistence fields or clear operation',()=>{
 const copy=html.slice(html.indexOf("if(action==='copy'){"),html.indexOf("if(action==='sent'){"));assert.equal(copy.slice(0,copy.indexOf('navigator.clipboard.writeText')).includes('await'),true); // only await of the clipboard call itself
 assert.match(copy,/try\{await navigator\.clipboard\.writeText/);assert.doesNotMatch(copy.slice(0,copy.indexOf('try{await navigator.clipboard.writeText')),/\bawait\b|locks\.request/);
 assert.doesNotMatch(html,/localStorage\.(?:clear|removeItem)|\bpurchaseId\b|\bhistoryExt\b|\bdatasetId\b|lockLab_v1_guard/);
});

test('strictCheck matches the approved baseline without adding it to update',()=>{
 const code=html.slice(html.indexOf('function strictCheck(data){'),html.indexOf('// LAB09: local-only backup evidence.'));
 assert.equal(require('node:crypto').createHash('sha256').update(code).digest('hex'),'ab17950ad4a4a8f1781bf07fc00d09e9019a1458fc9110531c91c3a12e6e7b56');
 const update=html.slice(html.indexOf('function update(fn,'),html.indexOf('function note(s)'));assert.doesNotMatch(update,/strictCheck/);
});
test('real reserve updates fresh storage without new identity or revision fields',async()=>{
 const c=boot({disk:stored(inventory())});await c.locks.idle();const fields={'select.qty':{value:'1'},'input.deal-name':{value:'ダミー取引'},'select.greeting-kind':{value:'normal'},'select.buyer-choice':{value:''}};
 const button={dataset:{product:'ダミー',store:'famima'},closest:()=>({querySelector:sel=>fields[sel]})};await c.click('inventory',{target:{closest:()=>button}});
 const data=JSON.parse(c.disk.get(KEYS.data));assert.equal(data.items[0].status,'reserved');assert.equal(data.deals[0].id,'lab-deal-1');assert.equal(data.seq,1);assert.deepEqual(Object.keys(data).sort(),['deals','items','lastOps','seq','templates','version']);
});
test('real cancellation restores reserved inventory and removes its deal',async()=>{
 const c=boot({disk:stored(inventory({reserved:true}))});await c.locks.idle();await c.click('deals',c.dealEvent('cancel'));const data=JSON.parse(c.disk.get(KEYS.data));assert.equal(data.deals.length,0);assert.equal(data.items[0].status,'available');assert.equal(data.items[0].dealId,null);
});
test('real sent confirmation preserves prepared text and updates inventory once',async()=>{
 const c=boot({disk:stored(inventory({reserved:true}))});await c.locks.idle();await c.click('deals',c.dealEvent('copy'));const text=c.api.db.deals[0].parts[0].messageSnapshot;await c.click('deals',c.dealEvent('sent'));const data=JSON.parse(c.disk.get(KEYS.data));assert.equal(data.items[0].status,'sent');assert.ok(data.deals[0].parts[0].sentAt);assert.equal(data.deals[0].parts[0].messageSnapshot,text);const before=c.disk.get(KEYS.data);await c.click('deals',c.dealEvent('sent'));assert.equal(c.disk.get(KEYS.data),before);
});
test('real split update writes new parts only before copy preparation',async()=>{
 const data=inventory({reserved:true});for(let i=2;i<=4;i++)data.items.push({...data.items[0],id:'https://example.invalid/'+i});const ids=data.items.map(x=>x.id);data.deals[0].itemIds=ids;data.deals[0].parts[0].ids=ids;
 const c=boot({disk:stored(data)});await c.locks.idle();const ev={target:{closest:()=>({dataset:{action:'resplit',id:'lab-deal-1'},closest:()=>({querySelector:()=>({value:'2,2'})})})}};
 await c.click('deals',ev);assert.deepEqual(JSON.parse(c.disk.get(KEYS.data)).deals[0].parts.map(x=>x.ids.length),[2,2]);await c.click('deals',c.dealEvent('copy'));const before=c.disk.get(KEYS.data);ev.target.closest=()=>({dataset:{action:'resplit',id:'lab-deal-1'},closest:()=>({querySelector:()=>({value:'4'})})});await c.click('deals',ev);assert.equal(c.disk.get(KEYS.data),before);
});
test('real greeting save retains inventory and applies the template edit',async()=>{
 const c=boot({disk:stored(inventory())});await c.locks.idle();c.get('greetingIntro').value='新しいダミー挨拶';c.get('greetingIntro').listeners.input();await c.click('saveGreeting');const data=JSON.parse(c.disk.get(KEYS.data));assert.equal(data.templates.normal,'新しいダミー挨拶');assert.deepEqual(data.items,inventory().items);
});
test('real buyer registration reports physical save failure without changing ledger',async()=>{
 for(const failWrite of [false,true]){const c=boot({fail:key=>failWrite&&key===KEYS.buyer});for(const [id,value]of Object.entries({buyerPrefix:'abc',buyerAlias:'ダミー',buyerKind:'normal',buyerRating:'unknown',buyerNote:'',buyerFullId:'dummy',buyerDisplayName:'ダミー表示'}))c.get(id).value=value;await c.click('buyerSave');if(failWrite){assert.equal(c.disk.has(KEYS.buyer),false);assert.match(c.get('buyerStatus').textContent,/保存停止/);}else assert.equal(JSON.parse(c.disk.get(KEYS.buyer)).records.length,1);}
});
