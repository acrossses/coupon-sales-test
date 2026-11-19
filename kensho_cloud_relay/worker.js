import relay from './relay-core.js';

const routes=new Map([
 ['/health','GET'],['/api/send','POST'],['/api/pending','GET'],
 ['/api/received','POST'],['/api/confirm','POST']
]);
function allowedOrigins(raw){
 return new Set(String(raw||'').split(',').map(x=>x.trim()).filter(value=>{
  try{const u=new URL(value);return u.protocol==='https:'&&u.origin===value;}catch{return false;}
 }));
}
export default {
 async fetch(request,env){
  const origin=request.headers.get('Origin');
  const headers={'cache-control':'no-store','vary':'Origin','x-content-type-options':'nosniff'};
  const reject=(status,error)=>Response.json({ok:false,error},{status,headers});
  if(origin!==null&&!allowedOrigins(env.ALLOWED_ORIGINS).has(origin))return reject(403,'Origin denied');
  if(origin!==null)headers['access-control-allow-origin']=origin;
  const method=routes.get(new URL(request.url).pathname);
  if(!method)return reject(404,'Not found');
  if(request.method==='OPTIONS'){
   const desired=request.headers.get('Access-Control-Request-Method');
   const names=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
   if(origin===null||desired!==method||names.some(x=>!['authorization','content-type'].includes(x)))return reject(403,'Preflight denied');
   return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':method,'access-control-allow-headers':'Authorization, Content-Type'}});
  }
  if(request.method!==method)return reject(405,'Method not allowed');
  const response=await relay.fetch(request,env);
  const combined=new Headers(response.headers);
  for(const [key,value] of Object.entries(headers))combined.set(key,value);
  return new Response(response.body,{status:response.status,headers:combined});
 }
};
