const fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/../index.html','utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const KEYS={data:'coupon_sales_release_rc2_storagetest',buyer:'coupon_sales_release_rc2_registry_v1_storagetest',meta:'coupon_sales_release_rc2_backup_evidence_v1_storagetest'};
class Locks{
 constructor(){this.tails=new Map();this.calls=[];this.active=new Set();}
 request(name,options,fn){this.calls.push(name);const prior=this.tails.get(name)||Promise.resolve();const task=prior.then(async()=>{this.active.add(name);try{return await fn({name});}finally{this.active.delete(name);}});this.tails.set(name,task.catch(()=>{}));return task;}
 async idle(){for(let i=0;i<4;i++){await Promise.all([...this.tails.values()]);await Promise.resolve();}}
}
class Element{
 constructor(){this.value='';this.textContent='';this.innerHTML='';this.children=[];this.dataset={};this.style={};this.listeners={};this.classList={add(){},remove(){},toggle(){}};this.disabled=false;this.hidden=false;this.checked=false;}
 addEventListener(name,fn){this.listeners[name]=fn;} querySelectorAll(){return [];} querySelector(){return new Element();}
 replaceChildren(...nodes){this.children=nodes;} append(...nodes){this.children.push(...nodes);} setAttribute(){} remove(){} before(){} focus(){} scrollIntoView(){}
}
function inventory({reserved=false}={}){
 const data={version:3,seq:reserved?1:0,lastOps:{},templates:{normal:'通常ダミー',repeat:'再来ダミー',regular:'常連ダミー',closing:'締めダミー'},items:[{id:'https://example.invalid/one',product:'ダミー',store:'famima',status:reserved?'reserved':'available',dealId:reserved?'lab-deal-1':null}],deals:[]};
 if(reserved)data.deals.push({id:'lab-deal-1',label:'取引ダミー',product:'ダミー',store:'famima',itemIds:[data.items[0].id],createdAt:'2026-11-01T00:00:00.000Z',buyerSnapshot:null,greetingSnapshot:{kind:'normal',greeting:'通常ダミー',closing:'締めダミー'},parts:[{ids:[data.items[0].id],copyIntentAt:null,copiedAt:null,sentAt:null,messageSnapshot:null}]});
 return data;
}
function buyer(){return {id:'buyer-00000000-0000-4000-8000-000000000001',prefix:'abc',fullId:'dummy-001',displayName:'ダミー購入者',alias:'ダミー',kind:'normal',rating:'unknown',note:'ダミーのみ',updatedAt:'2026-11-01T00:00:00.000Z'};}
function boot({disk=new Map(),locks=new Locks(),unsupported=false,fail=()=>false,afterWrite=()=>{},confirm=()=>true,clipboard=()=>Promise.resolve()}={}){
 const nodes=new Map(),events={},writes=[],reads=[],requests=[],copies=[],order=[];
 const get=id=>{if(!nodes.has(id)){const el=new Element();if(id==='editGreetingKind')el.value='normal';nodes.set(id,el);}return nodes.get(id);};
 let reloads=0;
 const window={addEventListener:(name,fn)=>events[name]=fn,location:{reload(){reloads++;}}};
 const ctx=vm.createContext({window,navigator:{locks:unsupported?undefined:locks,clipboard:{writeText(text){order.push('clipboard');copies.push(text);return clipboard(text);}}},document:{getElementById:get,querySelectorAll:()=>[],createElement:()=>new Element(),createTextNode:s=>s,body:new Element()},localStorage:{getItem(key){reads.push(key);return disk.get(key)??null;},setItem(key,value){if(fail(key))throw Error('simulated quota');writes.push(key);order.push('save:'+key);disk.set(key,value);afterWrite(key,disk);}},URL,Map,Set,Date,structuredClone,setTimeout,clearTimeout,AbortController,console,crypto:require('node:crypto').webcrypto,requestAnimationFrame(){},confirm,alert(){},fetch:async(...args)=>{requests.push(args);throw Error('No external network in tests');}});
 for(let i=0;i<scripts.length;i++){
  let script=scripts[i];if(i===scripts.length-1){const end=script.lastIndexOf('})();');script=script.slice(0,end)+`window.__plan={update,saveBuyers,saveBackupMeta,markBackupCreated,confirmBackupSaved,storagePlan,strictCheck,initial,validateBuyerLedger, get db(){return db},get buyers(){return buyers},get backupMeta(){return backupMeta},get blocked(){return blocked}, get needsReload(){return storageNeedsReload},setRegistration(){const line={line:1,value:'https://example.invalid/new',store:'famima'};const selections=[{x:line,store:'famima'}];$('urlInput').value=line.value;$('newProduct').value='ダミー';preview={product:'ダミー',raw:line.value,dbStamp:JSON.stringify(db.items.map(x=>x.id)),reviewed:{ack:true,fingerprint:registrationFingerprint(selections)}};registrationSelections=()=>{verifyPreview();return selections;};requireInspected=()=>{};let notified=0;relayInbox.recordSaved=()=>notified++;return ()=>notified;}};`+script.slice(end);}
  vm.runInContext(script,ctx);
 }
 const api=window.__plan;window.rc2RegistrationConfirm=async()=>confirm();
 return {api,disk,locks,nodes,get,events,writes,reads,requests,copies,order,ctx,
  get reloads(){return reloads;},
  click(id,event={}){return get(id).listeners.click(event);},
  dealEvent(action,part=0){return {target:{closest:()=>({dataset:{action,id:'lab-deal-1',part:String(part)}})}};}
 };
}
module.exports={html,KEYS,Locks,boot,inventory,buyer};
