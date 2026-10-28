// 鍵付き共有URL：シフトを暗号化してGitHubのデータ専用リポジトリへ置き、URLの#以降の鍵で端末内だけ復号する。
// GitHubに置くのは暗号文だけ。鍵はURLと公開端末のブラウザにだけ残る。
(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.ShiftCloud=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  var DATA_REPO='nosuke10311031-cloud/shift-maker-data';
  var BRANCH='main';
  var API='https://api.github.com';
  // LINEは「-」でリンク判定を切るため、鍵は英数字だけにする。62種×22文字で約131ビット。
  var ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var KEY_LENGTH=22;

  function cryptoApi(){
    var c=typeof crypto!=='undefined'?crypto:null;
    if(!c||!c.subtle||!c.getRandomValues)throw new Error('この端末のブラウザでは暗号化を使えません。');
    return c;
  }
  function randomKey(){
    var c=cryptoApi(),out='';
    while(out.length<KEY_LENGTH){
      var bytes=c.getRandomValues(new Uint8Array(32));
      for(var i=0;i<bytes.length&&out.length<KEY_LENGTH;i++){
        // 偏りを避けるため、62の倍数に収まる値だけ使う。
        if(bytes[i]<248)out+=ALPHABET.charAt(bytes[i]%62);
      }
    }
    return out;
  }
  function isKey(value){return typeof value==='string'&&/^[A-Za-z0-9]{22}$/.test(value);}

  function bytesToBase64(bytes){
    var bin='';for(var i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToBytes(text){
    var bin=atob(String(text||'').replace(/\s+/g,'')),out=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
    return out;
  }
  function utf8(text){return new TextEncoder().encode(text);}
  async function sha256Hex(text){
    var hash=new Uint8Array(await cryptoApi().subtle.digest('SHA-256',utf8(text)));
    return Array.prototype.map.call(hash,function(b){return b.toString(16).padStart(2,'0');}).join('');
  }
  // ファイル名は鍵から一方向に作る。ファイル名から鍵は戻せない。
  async function idFor(kind,key){return (await sha256Hex('shiftmaker-'+kind+'-id:'+key)).slice(0,24);}
  async function aesKey(key){
    var raw=await cryptoApi().subtle.digest('SHA-256',utf8('shiftmaker-enc:'+key));
    return cryptoApi().subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
  }
  async function encryptJSON(key,value){
    var iv=cryptoApi().getRandomValues(new Uint8Array(12));
    var ct=new Uint8Array(await cryptoApi().subtle.encrypt({name:'AES-GCM',iv:iv},await aesKey(key),utf8(JSON.stringify(value))));
    return JSON.stringify({v:1,iv:bytesToBase64(iv),ct:bytesToBase64(ct)});
  }
  async function decryptJSON(key,text){
    var box=JSON.parse(text);
    if(!box||box.v!==1||!box.iv||!box.ct)throw new Error('公開データの形式が正しくありません。');
    var plain;
    try{plain=await cryptoApi().subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(box.iv)},await aesKey(key),base64ToBytes(box.ct));}
    catch(e){throw new Error('鍵が一致しないため読めません。');}
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function viewPath(id,file){return 'v/'+id+'/'+file+'.json';}
  function backupPath(id,ym){return 'b/'+id+'/'+ym+'.json';}
  function contentsUrl(repo,path){return API+'/repos/'+repo+'/contents/'+path;}

  async function requestJSON(fetchImpl,url,options){
    var res;
    try{res=await fetchImpl(url,options);}
    catch(e){var ne=new Error('GitHubに接続できませんでした。通信状態を確認してください。');ne.network=true;throw ne;}
    var body=null;try{body=await res.json();}catch(e){}
    return {status:res.status,body:body};
  }
  function authHeaders(token){return {Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'};}
  function apiError(res,action){
    var detail=res.body&&res.body.message?'（'+res.body.message+'）':'';
    if(res.status===401)return new Error('トークンが無効か期限切れです。公開設定でトークンを入れ直してください。'+detail);
    if(res.status===403||res.status===404)return new Error('トークンでデータ用リポジトリに書き込めません。リポジトリ名とトークンの権限（Contents: Read and write）を確認してください。'+detail);
    return new Error(action+'に失敗しました（'+res.status+'）。'+detail);
  }

  // 書き込み用：トークン付きで読む（公開側のキャッシュを通さない）。
  async function readAuthed(o,path){
    var res=await requestJSON(o.fetch,contentsUrl(o.repo,path)+'?ref='+BRANCH,{headers:authHeaders(o.token),cache:'no-store'});
    if(res.status===404)return null;
    if(res.status!==200)throw apiError(res,'読み込み');
    return {sha:res.body.sha,text:new TextDecoder().decode(base64ToBytes(res.body.content||''))};
  }
  async function writeFile(o,path,text,message){
    for(var attempt=0;attempt<2;attempt++){
      var current=await readAuthed(o,path);
      var body={message:message,content:btoa(text),branch:BRANCH};
      if(current)body.sha=current.sha;
      var res=await requestJSON(o.fetch,contentsUrl(o.repo,path),{method:'PUT',headers:authHeaders(o.token),body:JSON.stringify(body)});
      if(res.status===200||res.status===201)return;
      // 直前に別の公開で更新された場合だけ、最新の版を取り直して1回やり直す。
      if((res.status===409||res.status===422)&&attempt===0)continue;
      throw apiError(res,'保存');
    }
  }
  async function deleteFile(o,path,message){
    var current=await readAuthed(o,path);if(!current)return;
    var res=await requestJSON(o.fetch,contentsUrl(o.repo,path),{method:'DELETE',headers:authHeaders(o.token),body:JSON.stringify({message:message,sha:current.sha,branch:BRANCH})});
    if(res.status!==200)throw apiError(res,'削除');
  }

  // 閲覧用：トークンなしで読む。GitHub APIを優先し、回数制限などで読めなければ raw へ切り替える。
  async function readPublic(o,path){
    var fetchImpl=o.fetch;
    try{
      var res=await fetchImpl(contentsUrl(o.repo,path)+'?ref='+BRANCH,{headers:{Accept:'application/vnd.github.raw+json'},cache:'no-store'});
      if(res.status===404)return null;
      if(res.status===200)return await res.text();
    }catch(e){}
    var raw;
    try{raw=await fetchImpl('https://raw.githubusercontent.com/'+o.repo+'/'+BRANCH+'/'+path+'?t='+Date.now(),{cache:'no-store'});}
    catch(e){var ne=new Error('シフトを読み込めませんでした。通信状態を確認してください。');ne.network=true;throw ne;}
    if(raw.status===404)return null;
    if(raw.status!==200)throw new Error('シフトを読み込めませんでした（'+raw.status+'）。');
    return await raw.text();
  }

  function options(o){
    o=o||{};
    return {repo:o.repo||DATA_REPO,token:o.token||'',fetch:o.fetch||(typeof fetch!=='undefined'?fetch.bind(typeof window!=='undefined'?window:globalThis):null)};
  }

  async function checkSetup(o){
    o=options(o);
    var res=await requestJSON(o.fetch,API+'/repos/'+o.repo,{headers:authHeaders(o.token),cache:'no-store'});
    if(res.status!==200)throw apiError(res,'接続確認');
    if(res.body&&res.body.private)throw new Error('データ用リポジトリが非公開のため、スタッフのスマホから読めません。Public にしてください（中身は暗号化されています）。');
    return true;
  }

  // 月を公開：閲覧用（共有URLの鍵）と復元用（復元用コード）を別の鍵で保存し、月の一覧を更新する。
  async function publishMonth(o,args){
    o=options(o);
    if(!isKey(args.viewKey)||!isKey(args.backupKey))throw new Error('鍵が正しくありません。');
    var viewId=await idFor('view',args.viewKey),backupId=await idFor('backup',args.backupKey),at=args.publishedAt||new Date().toISOString();
    await writeFile(o,viewPath(viewId,args.ym),await encryptJSON(args.viewKey,{t:'shift-view',ym:args.ym,publishedAt:at,stores:args.stores}),'Publish shift view');
    await writeFile(o,backupPath(backupId,args.ym),await encryptJSON(args.backupKey,{t:'shift-backup',ym:args.ym,publishedAt:at,period:args.period}),'Publish shift backup');
    var current=await readAuthed(o,viewPath(viewId,'index')),index={t:'shift-index',months:{}};
    if(current)index=await decryptJSON(args.viewKey,current.text);
    index.months[args.ym]={publishedAt:at};
    await writeFile(o,viewPath(viewId,'index'),await encryptJSON(args.viewKey,index),'Update shift index');
    return {publishedAt:at};
  }

  async function loadIndex(o,viewKey){
    o=options(o);
    var text=await readPublic(o,viewPath(await idFor('view',viewKey),'index'));
    return text?decryptJSON(viewKey,text):null;
  }
  async function loadMonth(o,viewKey,ym){
    o=options(o);
    var text=await readPublic(o,viewPath(await idFor('view',viewKey),ym));
    return text?decryptJSON(viewKey,text):null;
  }
  async function loadBackup(o,backupKey,ym){
    o=options(o);
    var text=await readPublic(o,backupPath(await idFor('backup',backupKey),ym));
    return text?decryptJSON(backupKey,text):null;
  }

  // 共有URLの鍵を作り直す：公開済みの月を新しい鍵で置き直してから、古い鍵のファイルを消す。
  async function rotateViewKey(o,oldKey,newKey){
    o=options(o);
    var oldId=await idFor('view',oldKey),newId=await idFor('view',newKey);
    var current=await readAuthed(o,viewPath(oldId,'index')),index=current?await decryptJSON(oldKey,current.text):{t:'shift-index',months:{}};
    var months=Object.keys(index.months||{});
    for(var i=0;i<months.length;i++){
      var file=await readAuthed(o,viewPath(oldId,months[i]));
      if(file)await writeFile(o,viewPath(newId,months[i]),await encryptJSON(newKey,await decryptJSON(oldKey,file.text)),'Rotate shift view key');
    }
    await writeFile(o,viewPath(newId,'index'),await encryptJSON(newKey,index),'Rotate shift view key');
    for(var j=0;j<months.length;j++)await deleteFile(o,viewPath(oldId,months[j]),'Remove old shift view');
    await deleteFile(o,viewPath(oldId,'index'),'Remove old shift view');
    return months.length;
  }

  function keyFromUrl(text){
    var match=String(text||'').trim().match(/#([A-Za-z0-9]{22})(?:$|[^A-Za-z0-9])/);
    return match?match[1]:'';
  }
  function shareUrl(viewerUrl,viewKey){
    var base=String(viewerUrl||'').split('#')[0].split('?')[0];
    return base+'#'+viewKey;
  }

  return {
    DATA_REPO:DATA_REPO,randomKey:randomKey,isKey:isKey,idFor:idFor,encryptJSON:encryptJSON,decryptJSON:decryptJSON,
    checkSetup:checkSetup,publishMonth:publishMonth,loadIndex:loadIndex,loadMonth:loadMonth,loadBackup:loadBackup,
    rotateViewKey:rotateViewKey,keyFromUrl:keyFromUrl,shareUrl:shareUrl
  };
});
