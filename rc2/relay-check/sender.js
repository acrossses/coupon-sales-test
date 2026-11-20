(()=>{
 'use strict';
 const endpoint='https://kensho-relay.coupon-relay-hub.workers.dev/api/send';
 const markerKey='coupon_sales_prod_dummy_check_v1';
 const $=id=>document.getElementById(id);
 let item=null,busy=false,finished=false,unusable=false;
 const status=text=>{$('status').textContent=text;};
 try{
  if(location.origin!=='https://acrossses.github.io')throw Error('wrong origin');
  let marker=localStorage.getItem(markerKey);
  if(marker===null){marker=crypto.randomUUID();localStorage.setItem(markerKey,marker);}
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(marker))throw Error('invalid marker');
  item={url:'https://example.invalid/rc2-production-dummy/'+marker,product:'動作確認ダミー-'+marker.slice(0,8),store:'famima',campaign:'RC2-PROD-DUMMY-20261120'};
  $('product').textContent=item.product;
  $('send').disabled=false;
  status('送信キーを入力して、ダミーを1件送信してください。');
 }catch{
  unusable=true;
  status('この画面では準備できませんでした。正式な配信URLとブラウザの保存設定を確認してください。');
 }
 $('sendForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(unusable||busy||finished||!item)return;
  let key=$('senderKey').value;
  if(!key||/\s/.test(key)){status('空白を含まない本番の送信キーを入力してください。');return;}
  busy=true;$('send').disabled=true;status('ダミー1件を送信しています。');
  try{
   const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({items:[item]}),credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});
   const data=await response.json();
   if(response.status===401){status('送信キーが一致しません。SENDER_KEYを確認してください。');return;}
   if(!response.ok||data.ok!==true||!((data.inserted===1&&data.duplicates===0)||(data.inserted===0&&data.duplicates===1))){status('受付を確認できませんでした（HTTP '+response.status+'）。同じダミーで再確認できます。');return;}
   finished=true;
   status(data.inserted===1?'送信受付済み。正式版で上の商品名の新着を取得してください。':'このダミーは既に受付済みです。重複追加はしていません。正式版で商品名を確認してください。');
  }catch{
   status('送信結果を確認できませんでした。再送しても同じダミーを使います。');
  }finally{
   key='';$('senderKey').value='';busy=false;$('send').disabled=finished||unusable;
  }
 });
 window.addEventListener('pagehide',()=>{$('senderKey').value='';});
 window.addEventListener('pageshow',()=>{$('senderKey').value='';});
})();
