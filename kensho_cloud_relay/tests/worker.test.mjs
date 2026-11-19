import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import worker from '../worker.js';
const origin='https://acrossses.github.io',base='https://worker.example.invalid';
const coupon={url:'https://example.invalid/dummy?token=a%2Fb#keep',product:'DUMMY',store:'famima',campaign:'TEST'};
function setup(t){
 const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>sql.close());
 const state={batchFailure:false,params:[]};
 const DB={prepare(query){
  const statement=sql.prepare(query);let values=[];
  const api={bind(...args){assert.ok(args.length<=100,'D1 bound-parameter limit');values=args;state.params.push(args.length);return api},execute(){return {results:statement.all(...values),meta:{changes:0}}},async run(){return {meta:{changes:Number(statement.run(...values).changes)}}},async all(){return {results:statement.all(...values)}}};return api;
 },async batch(statements){
  sql.exec('BEGIN IMMEDIATE');
  try{const results=statements.map((s,i)=>{const result=s.execute();if(state.batchFailure&&i===0)throw Error('injected database error DUMMY_SECRET');return result});sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}
 }};
 const env={DB,SENDER_KEY:'dummy-sender',RECEIVER_KEY:'dummy-receiver',ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),ALLOWED_ORIGINS:origin};
 const req=(path,{key=env.RECEIVER_KEY,body,method=body?'POST':'GET',from=origin,headers={}}={})=>new Request(base+path,{method,headers:{...(from!==null?{Origin:from}:{}),...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 const call=(path,options)=>worker.fetch(req(path,options),env);
 const confirm=(ids,extra={})=>call('/api/confirm',{body:{ids,rc2Saved:true},...extra});
 function seed(status='pending'){
  const id=randomUUID();sql.prepare('INSERT INTO transfers(id,digest,product,store,url_ciphertext,url_nonce,status,created_at,confirmed_at,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,id,'DUMMY','famima','dummy','dummy',status,'2026-11-01T00:00:00Z',status==='confirmed'?'2026-11-02T00:00:00Z':null,status!=='pending'?'2026-11-01T01:00:00Z':null);return id;
 }
 return {sql,env,state,req,call,confirm,seed};
}
test('allowed origin receives route-specific preflight without a key',async t=>{
 const s=setup(t);
 for(const [path,method] of [['/api/pending','GET'],['/api/send','POST'],['/api/confirm','POST'],['/api/received','POST'],['/health','GET']]){
  const r=await s.call(path,{method:'OPTIONS',key:null,headers:{'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'Authorization, Content-Type'}});assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.equal(r.headers.get('access-control-allow-methods'),method);assert.equal(r.headers.get('access-control-allow-credentials'),null);
 }
});
test('foreign, null and missing preflight origins do not reach the database',async t=>{
 const s=setup(t);s.env.DB=null;
 for(const from of ['https://evil.invalid','null',null,'https://acrossses.github.io.evil.invalid']){
  const r=await s.call('/api/confirm',{method:'OPTIONS',key:null,from,headers:{'Access-Control-Request-Method':'POST'}});assert.equal(r.status,403);assert.equal(r.headers.get('access-control-allow-origin'),null);
 }
});
test('wildcard, paths, credentials, HTTP and malformed allowlist entries cannot permit origins',async t=>{
 const s=setup(t);
 for(const raw of ['*','null',origin+'/path','https://user:pass@acrossses.github.io','http://acrossses.github.io',origin+' '+origin]){
  s.env.ALLOWED_ORIGINS=raw;assert.equal((await s.call('/health',{key:null})).status,403);
 }
 s.env.ALLOWED_ORIGINS='https://other.invalid, '+origin;assert.equal((await s.call('/health',{key:null})).status,200);
});
test('preflight rejects wrong method, unsupported headers and unknown route',async t=>{
 const s=setup(t);
 for(const headers of [{'Access-Control-Request-Method':'POST'},{'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-custom'},{}])assert.equal((await s.call('/api/pending',{method:'OPTIONS',headers})).status,403);
 assert.equal((await s.call('/unknown',{method:'OPTIONS'})).status,404);
 assert.equal((await s.call('/api/pending',{method:'DELETE'})).status,405);
});
test('CORS permits no bypass of role or rc2Saved checks; errors retain CORS',async t=>{
 const s=setup(t),id=s.seed();
 for(const key of [null,'wrong',s.env.SENDER_KEY]){
  const r=await s.confirm([id],{key});assert.equal(r.status,401);assert.equal(r.headers.get('access-control-allow-origin'),origin);
 }
 assert.equal((await s.call('/api/send',{body:{items:[coupon]}})).status,401);
 assert.equal((await s.call('/api/confirm',{body:{ids:[id],rc2Saved:false}})).status,400);
 assert.equal(s.sql.prepare('SELECT status FROM transfers').get().status,'pending');
});
test('non-browser authenticated sender and exact encrypted URL behavior remain compatible',async t=>{
 const s=setup(t),options={from:null,key:s.env.SENDER_KEY,body:{items:[coupon]}};
 const r=await s.call('/api/send',options);assert.equal(r.status,200);assert.equal((await r.json()).inserted,1);assert.equal(r.headers.get('access-control-allow-origin'),null);
 assert.equal((await (await s.call('/api/send',options)).json()).duplicates,1);
 const row=s.sql.prepare('SELECT * FROM transfers').get();assert.ok(!JSON.stringify(row).includes(coupon.url));
 const inbox=await (await s.call('/api/pending')).json();assert.equal(inbox.items[0].url,coupon.url);assert.equal(inbox.items[0].status,'pending');
});
test('pending and received confirm successfully with actual update counts',async t=>{
 const s=setup(t),ids=[s.seed(),s.seed('received')];
 const response=await s.confirm(ids);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,processed:2,updated:2,alreadyConfirmed:0});
 assert.equal(s.sql.prepare("SELECT count(*) n FROM transfers WHERE status='confirmed'").get().n,2);
});
test('unknown ID is a failure, not successful processed=1',async t=>{
 const s=setup(t);s.seed();const r=await s.confirm([randomUUID()]);assert.equal(r.status,404);assert.deepEqual(await r.json(),{ok:false,error:'Unknown transfer ID',processed:0});assert.equal(s.sql.prepare('SELECT status FROM transfers').get().status,'pending');
});
test('mixed known and unknown IDs do not partially confirm valid rows',async t=>{
 const s=setup(t),a=s.seed(),b=s.seed('received');assert.equal((await s.confirm([a,randomUUID(),b])).status,404);
 assert.deepEqual(s.sql.prepare('SELECT status FROM transfers ORDER BY rowid').all().map(x=>x.status),['pending','received']);assert.equal(s.sql.prepare('SELECT confirmed_at FROM transfers WHERE id=?').get(a).confirmed_at,null);
});
test('already-confirmed retry succeeds and preserves original timestamps after lost response',async t=>{
 const s=setup(t),id=s.seed();await s.confirm([id]); // first HTTP result deliberately ignored
 const before=s.sql.prepare('SELECT * FROM transfers').get();const r=await s.confirm([id]);assert.deepEqual(await r.json(),{ok:true,processed:1,updated:0,alreadyConfirmed:1});assert.deepEqual(s.sql.prepare('SELECT * FROM transfers').get(),before);
});
test('mixed confirmed and pending reports distinct counts; duplicate IDs count once',async t=>{
 const s=setup(t),a=s.seed('confirmed'),b=s.seed();const r=await s.confirm([a,b,a,b]);assert.deepEqual(await r.json(),{ok:true,processed:2,updated:1,alreadyConfirmed:1});assert.equal(s.sql.prepare('SELECT confirmed_at FROM transfers WHERE id=?').get(a).confirmed_at,'2026-11-02T00:00:00Z');
});
test('200 IDs remain supported within the real D1 parameter ceiling',async t=>{
 const s=setup(t),ids=Array.from({length:200},()=>s.seed());const r=await s.confirm(ids);assert.equal(r.status,200);assert.equal((await r.json()).updated,200);assert.ok(Math.max(...s.state.params)<=100);
});
test('malformed IDs and more than 200 IDs are rejected without writes',async t=>{
 const s=setup(t);s.seed();for(const ids of [[],['-'.repeat(36)],['not-uuid'],[null],Array.from({length:201},()=>randomUUID())])assert.equal((await s.confirm(ids)).status,400);assert.equal(s.sql.prepare('SELECT status FROM transfers').get().status,'pending');
});
test('database failure rolls back confirm and never exposes secret exception text',async t=>{
 const s=setup(t),id=s.seed();s.state.batchFailure=true;const r=await s.confirm([id]);assert.equal(r.status,500);const text=await r.text();assert.ok(!text.includes('DUMMY_SECRET'));assert.ok(!text.includes(id));assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.equal(s.sql.prepare('SELECT status FROM transfers').get().status,'pending');
});
test('unexpected legacy status fails without altering other pending rows',async t=>{
 const s=setup(t),a=s.seed(),b=s.seed();s.sql.exec('PRAGMA ignore_check_constraints=ON');s.sql.prepare("UPDATE transfers SET status='unexpected' WHERE id=?").run(b);
 assert.equal((await s.confirm([a,b])).status,409);assert.equal(s.sql.prepare('SELECT status FROM transfers WHERE id=?').get(a).status,'pending');
});
test('confirmed coupons leave pending and cannot reappear on sender retry',async t=>{
 const s=setup(t);await s.call('/api/send',{key:s.env.SENDER_KEY,body:{items:[coupon]}});const id=(await (await s.call('/api/pending')).json()).items[0].id;
 await s.confirm([id]);assert.deepEqual((await (await s.call('/api/pending')).json()).items,[]);
 assert.equal((await (await s.call('/api/send',{key:s.env.SENDER_KEY,body:{items:[coupon]}})).json()).duplicates,1);assert.deepEqual((await (await s.call('/api/pending')).json()).items,[]);
});
test('existing received endpoint remains authenticated and does not confirm',async t=>{
 const s=setup(t),id=s.seed();assert.equal((await s.call('/api/received',{body:{ids:[id]}})).status,200);assert.equal(s.sql.prepare('SELECT status FROM transfers').get().status,'received');assert.equal((await s.confirm([id])).status,200);
});
