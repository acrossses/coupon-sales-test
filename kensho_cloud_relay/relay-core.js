/**
 * Kensho coupon relay, private Worker + D1.
 * Tokens and AES key are Cloudflare Worker secrets, never source-controlled.
 * Pending -> received is an observational state, not an RC2 registration.
 * Only explicit /api/confirm after successful RC2 local save may confirm.
 */
const JSON_HEADERS = {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const allowedStores = new Set(['seven','famima','lawson','other']);
const encoder = new TextEncoder();
const toB64 = bytes => btoa(String.fromCharCode(...bytes));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const reply = (body,status=200) => new Response(JSON.stringify(body),{status,headers:JSON_HEADERS});
const fail = (message,status=400) => reply({ok:false,error:message},status);
const isText = (s,max) => typeof s==='string' && s.length<=max && !/[\u0000-\u001f\u007f]/.test(s);
const httpsUrl = value => {
  if(!isText(value,8192)||!value || /\s/.test(value))return false;
  try {const u=new URL(value);return u.protocol==='https:' && !u.username && !u.password;}catch{return false;}
};
async function equalSecret(supplied, expected){
  if(!expected||typeof expected!=='string'||!supplied||typeof supplied!=='string')return false;
  // Hash before comparing: fixed-length bytes regardless of secret lengths.
  const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encoder.encode(supplied)),crypto.subtle.digest('SHA-256',encoder.encode(expected))]);
  const x=new Uint8Array(a),y=new Uint8Array(b);let difference=0;
  for(let i=0;i<x.length;i++)difference|=x[i]^y[i];
  return difference===0;
}
async function keyFor(env){
  if(!env.ENCRYPTION_KEY)throw Error('Server encryption key not configured');
  const raw=fromB64(env.ENCRYPTION_KEY);
  if(raw.byteLength!==32)throw Error('Encryption key must contain exactly 32 bytes');
  return crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
}
async function digestFor(url,env){
  const secret=fromB64(env.ENCRYPTION_KEY);
  const key=await crypto.subtle.importKey('raw',secret,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const value=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(url)));
  return [...value].map(n=>n.toString(16).padStart(2,'0')).join('');
}
async function encryptUrl(url,env){
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},await keyFor(env),encoder.encode(url));
  return {ciphertext:toB64(new Uint8Array(ciphertext)),nonce:toB64(nonce)};
}
async function decryptUrl(row,env){
  const decoded=await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(row.url_nonce)},await keyFor(env),fromB64(row.url_ciphertext));
  return new TextDecoder().decode(decoded);
}
async function parseBody(request,max=120000){
  const contentLength=Number(request.headers.get('content-length')||0);
  if(contentLength>max)throw Error('Payload too large');
  const raw=await request.text();if(raw.length>max)throw Error('Payload too large');
  return JSON.parse(raw);
}
async function requireRole(request,env,role){
  const auth=request.headers.get('authorization')||'';
  const match=/^Bearer ([^\s]+)$/.exec(auth);
  return equalSecret(match?.[1],role==='sender'?env.SENDER_KEY:env.RECEIVER_KEY);
}
const asPublic = row => ({id:row.id,product:row.product,store:row.store,campaign:row.campaign,status:row.status,createdAt:row.created_at,receivedAt:row.received_at});
export default {
  async fetch(request,env){
    try {
      if(!env.DB||!env.SENDER_KEY||!env.RECEIVER_KEY||!env.ENCRYPTION_KEY)return fail('Service not configured',503);
      const path=new URL(request.url).pathname;
      if(path==='/health' && request.method==='GET')return reply({ok:true,service:'kensho-relay'});
      if(path==='/api/send' && request.method==='POST'){
        if(!await requireRole(request,env,'sender'))return fail('Unauthorized',401);
        const input=await parseBody(request),rows=input?.items;
        if(!Array.isArray(rows)||!rows.length||rows.length>50)return fail('Supply 1 to 50 items');
        const normalized=[];const local=new Set();
        for(const x of rows){
          if(!httpsUrl(x?.url)||!isText(x?.product,100)||!x.product.trim()||!allowedStores.has(x.store)||!isText(x?.campaign??'',256))return fail('Invalid coupon item');
          if(local.has(x.url))return fail('Duplicate URL in request');
          local.add(x.url);normalized.push({url:x.url,product:x.product.trim(),store:x.store,campaign:x.campaign||''});
        }
        const result=[];
        for(const x of normalized){
          const digest=await digestFor(x.url,env),id=crypto.randomUUID(),cipher=await encryptUrl(x.url,env);
          const write=await env.DB.prepare('INSERT OR IGNORE INTO transfers (id,digest,product,store,campaign,url_ciphertext,url_nonce,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .bind(id,digest,x.product,x.store,x.campaign,cipher.ciphertext,cipher.nonce,'pending',new Date().toISOString()).run();
          result.push({accepted:write.meta.changes===1,duplicate:write.meta.changes===0});
        }
        return reply({ok:true,inserted:result.filter(x=>x.accepted).length,duplicates:result.filter(x=>x.duplicate).length});
      }
      if(path==='/api/pending' && request.method==='GET'){
        if(!await requireRole(request,env,'receiver'))return fail('Unauthorized',401);
        const rows=(await env.DB.prepare("SELECT * FROM transfers WHERE status != 'confirmed' ORDER BY created_at ASC LIMIT 200").all()).results||[];
        return reply({ok:true,items:await Promise.all(rows.map(async r=>({...asPublic(r),url:await decryptUrl(r,env)})))});
      }
      if(path==='/api/received' && request.method==='POST'){
        if(!await requireRole(request,env,'receiver'))return fail('Unauthorized',401);
        const input=await parseBody(request);
        if(!Array.isArray(input?.ids)||input.ids.length>200||input.ids.some(v=>typeof v!=='string'||!(/^[0-9a-f-]{36}$/.test(v))))return fail('Invalid IDs');
        for(const id of [...new Set(input.ids)])await env.DB.prepare("UPDATE transfers SET status='received',received_at=COALESCE(received_at,?) WHERE id=? AND status='pending'").bind(new Date().toISOString(),id).run();
        return reply({ok:true});
      }
      if(path==='/api/confirm' && request.method==='POST'){
        if(!await requireRole(request,env,'receiver'))return fail('Unauthorized',401);
        const input=await parseBody(request);
        if(!Array.isArray(input?.ids)||!input.ids.length||input.ids.length>200||input.ids.some(v=>typeof v!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v))))return fail('Invalid IDs');
        if(input.rc2Saved!==true)return fail('Explicit RC2 save confirmation required');
        const unique=[...new Set(input.ids)], ids=JSON.stringify(unique), now=new Date().toISOString();
        // One atomic D1 batch. Unknown/invalid IDs make the guarded UPDATE a no-op.
        // json_each keeps the 200-ID contract within D1's 100-bound-parameter limit.
        const [write, final] = await env.DB.batch([
          env.DB.prepare(`UPDATE transfers
            SET status='confirmed', confirmed_at=COALESCE(confirmed_at,?), received_at=COALESCE(received_at,?)
            WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('pending','received')
              AND (SELECT COUNT(*) FROM transfers WHERE id IN (SELECT value FROM json_each(?))
                   AND status IN ('pending','received','confirmed')) = ?
            RETURNING id`).bind(now,now,ids,ids,unique.length),
          env.DB.prepare('SELECT id,status FROM transfers WHERE id IN (SELECT value FROM json_each(?))').bind(ids)
        ]);
        const rows=final.results||[];
        if(rows.length!==unique.length)return reply({ok:false,error:'Unknown transfer ID',processed:0},404);
        if(rows.some(row=>row.status!=='confirmed'))return reply({ok:false,error:'Transfer state does not allow confirmation',processed:0},409);
        const updated=(write.results||[]).length;
        return reply({ok:true,processed:unique.length,updated,alreadyConfirmed:unique.length-updated});
      }
      return fail('Not found',404);
    }catch(e){
      // Never return URL, encryption material, or request body in an error message.
      return fail('Request could not be completed',500);
    }
  }
};
