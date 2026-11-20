const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/sender.js','utf8');
const UUID='12345678-1234-4234-8234-123456789abc';
function boot({origin='https://acrossses.github.io',disk=new Map(),storageFails=false,transport=async()=>Response.json({ok:true,inserted:1,duplicates:0})}={}){
 const nodes=new Map(),requests=[],writes=[],listeners={};
 function get(id){if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:id==='send',listeners:{},addEventListener(type,callback){this.listeners[type]=callback;}});return nodes.get(id);}
 const localStorage={getItem:key=>{if(storageFails)throw Error('blocked');return disk.get(key)??null;},setItem:(key,value)=>{if(storageFails)throw Error('blocked');writes.push({key,value});disk.set(key,value);}};
 const context=vm.createContext({document:{getElementById:get},location:{origin},localStorage,crypto:{randomUUID:()=>UUID},window:{addEventListener:(name,callback)=>listeners[name]=callback},AbortSignal,fetch:async(url,options)=>{requests.push({url,options});return transport(url,options);}});
 vm.runInContext(source,context);
 return {get,requests,writes,disk,listeners,send:()=>get('sendForm').listeners.submit({preventDefault(){}})};
}
test('one click sends exactly one known dummy to the production endpoint and clears the key',async()=>{
 const c=boot();assert.equal(c.requests.length,0);c.get('senderKey').value='DUMMY_SENDER';await c.send();
 assert.equal(c.requests.length,1);const {url,options}=c.requests[0];assert.equal(url,'https://kensho-relay.coupon-relay-hub.workers.dev/api/send');assert.equal(options.headers.Authorization,'Bearer DUMMY_SENDER');
 const {items}=JSON.parse(options.body);assert.equal(items.length,1);assert.equal(items[0].url,'https://example.invalid/rc2-production-dummy/'+UUID);assert.equal(items[0].product,c.get('product').textContent);assert.equal(items[0].store,'famima');
 assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(c.get('senderKey').value,'');assert.equal(c.get('send').disabled,true);assert.ok(!JSON.stringify([...c.disk]).includes('DUMMY_SENDER'));assert.deepEqual([...c.disk.keys()],['coupon_sales_prod_dummy_check_v1']);
});
test('rapid repeated clicks cannot send while a request is in flight or after success',async()=>{
 let finish;const c=boot({transport:()=>new Promise(resolve=>finish=resolve)});c.get('senderKey').value='DUMMY';const first=c.send();await c.send();assert.equal(c.requests.length,1);finish(Response.json({ok:true,inserted:1,duplicates:0}));await first;await c.send();assert.equal(c.requests.length,1);
});
test('lost response and reload preserve the exact dummy URL for an idempotent retry',async()=>{
 const disk=new Map();const c=boot({disk,transport:async()=>{throw Error('lost response');}});c.get('senderKey').value='DUMMY';await c.send();assert.equal(c.get('senderKey').value,'');assert.equal(c.get('send').disabled,false);
 const retry=boot({disk,transport:async()=>Response.json({ok:true,inserted:0,duplicates:1})});retry.get('senderKey').value='DUMMY';await retry.send();assert.equal(retry.requests[0].options.body,c.requests[0].options.body);assert.match(retry.get('status').textContent,/既に受付済み/);assert.equal(retry.get('send').disabled,true);
});
test('401, ambiguous responses and hidden pages clear the key without marking success',async()=>{
 for(const response of [Response.json({ok:false},{status:401}),Response.json({ok:true,inserted:2,duplicates:0})]){
  const c=boot({transport:async()=>response});c.get('senderKey').value='DUMMY';await c.send();assert.equal(c.get('senderKey').value,'');assert.equal(c.get('send').disabled,false);assert.doesNotMatch(c.get('status').textContent,/送信受付済み/);
  c.get('senderKey').value='DUMMY';c.listeners.pagehide();assert.equal(c.get('senderKey').value,'');
 }
});
test('wrong origin, unusable storage and invalid saved marker cannot transmit',async()=>{
 for(const options of [{origin:'https://not-allowed.example.invalid'},{storageFails:true},{disk:new Map([['coupon_sales_prod_dummy_check_v1','broken']])}]){
  const c=boot(options);c.get('senderKey').value='DUMMY';await c.send();assert.equal(c.requests.length,0);assert.equal(c.get('send').disabled,true);
 }
});
test('blank or whitespace-containing keys cannot transmit',async()=>{
 for(const key of ['', 'DUMMY KEY']){const c=boot();c.get('senderKey').value=key;await c.send();assert.equal(c.requests.length,0);}
});
