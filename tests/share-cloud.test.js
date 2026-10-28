const assert=require('assert');
const cloud=require('../docs/share-cloud.js');

// GitHubの contents API と raw 配信を、版（sha）の検査つきで模した偽サーバー。
function fakeGitHub(options){
  options=options||{};
  const files=new Map(),log=[];let seq=0;
  const repo=options.repo||cloud.DATA_REPO,token=options.token||'test-token';
  const json=(status,body)=>({status,json:async()=>body,text:async()=>JSON.stringify(body)});
  const fetch=async(url,init)=>{
    init=init||{};const method=init.method||'GET',headers=init.headers||{};log.push({method,url,auth:!!headers.Authorization});
    if(options.offline)throw new Error('offline');
    if(url.startsWith('https://raw.githubusercontent.com/')){
      const path=url.replace('https://raw.githubusercontent.com/'+repo+'/main/','').split('?')[0];
      if(!files.has(path))return json(404,{});
      const text=files.get(path).text;return {status:200,json:async()=>JSON.parse(text),text:async()=>text};
    }
    if(url==='https://api.github.com/repos/'+repo){
      if(headers.Authorization!=='Bearer '+token)return json(401,{message:'Bad credentials'});
      return json(200,{private:!!options.private});
    }
    const prefix='https://api.github.com/repos/'+repo+'/contents/';
    assert.ok(url.startsWith(prefix),url);
    const path=url.slice(prefix.length).split('?')[0];
    if(method==='GET'){
      if(!headers.Authorization&&options.rateLimited)return json(403,{message:'rate limit'});
      if(!files.has(path))return json(404,{message:'Not Found'});
      const f=files.get(path);
      if(headers.Accept==='application/vnd.github.raw+json')return {status:200,json:async()=>JSON.parse(f.text),text:async()=>f.text};
      return json(200,{sha:f.sha,content:Buffer.from(f.text).toString('base64').replace(/(.{60})/g,'$1\n')});
    }
    if(headers.Authorization!=='Bearer '+token)return json(401,{message:'Bad credentials'});
    const body=JSON.parse(init.body);
    if(method==='PUT'){
      const cur=files.get(path);
      if(cur&&body.sha!==cur.sha)return json(409,{message:'sha mismatch'});
      if(!cur&&body.sha)return json(422,{message:'sha for new file'});
      files.set(path,{sha:'s'+(++seq),text:Buffer.from(body.content,'base64').toString('utf8')});
      return json(cur?200:201,{});
    }
    if(method==='DELETE'){
      const cur=files.get(path);if(!cur||body.sha!==cur.sha)return json(409,{message:'sha mismatch'});
      files.delete(path);return json(200,{});
    }
    throw new Error('unexpected '+method);
  };
  return {files,log,fetch,repo,token};
}

(async()=>{
  // 鍵：英数字22文字だけ（LINEがリンクを切る「-」「_」を含まない）、毎回違う。
  const keys=new Set();
  for(let i=0;i<300;i++){const k=cloud.randomKey();assert.ok(/^[A-Za-z0-9]{22}$/.test(k),k);keys.add(k);}
  assert.equal(keys.size,300);
  assert.equal(cloud.isKey('abc'),false);

  // 暗号化：正しい鍵だけで戻せる。暗号文に元の名前が含まれない。
  const k1=cloud.randomKey(),k2=cloud.randomKey();
  const box=await cloud.encryptJSON(k1,{name:'テスト太郎',n:1});
  assert.ok(!box.includes('テスト')&&!box.includes('太郎'));
  assert.deepEqual(await cloud.decryptJSON(k1,box),{name:'テスト太郎',n:1});
  await assert.rejects(cloud.decryptJSON(k2,box),/鍵が一致しない/);
  assert.notEqual(await cloud.encryptJSON(k1,{a:1}),await cloud.encryptJSON(k1,{a:1}));

  // URL：#以降の鍵だけを取り出す。
  const url=cloud.shareUrl('https://example.github.io/shift-maker/view.html?shift=old#x',k1);
  assert.equal(url,'https://example.github.io/shift-maker/view.html#'+k1);
  assert.equal(cloud.keyFromUrl(url),k1);
  assert.equal(cloud.keyFromUrl('LINE本文 '+url+' です'),k1);
  assert.equal(cloud.keyFromUrl('https://x/view.html#short'),'');

  // 公開→閲覧→復元。閲覧用と復元用は別の鍵・別のファイルで、互いに読めない。
  const gh=fakeGitHub();
  const o={fetch:gh.fetch,token:gh.token};
  const viewKey=cloud.randomKey(),backupKey=cloud.randomKey();
  await cloud.checkSetup(o);
  await cloud.publishMonth(o,{viewKey,backupKey,ym:'2026-11',stores:{midori:{z:4,n:['テスト']}},period:{v:4,year:2026,month:11,members:[{id:'a',name:'テスト'}]},publishedAt:'2026-10-28T10:00:00.000Z'});
  await cloud.publishMonth(o,{viewKey,backupKey,ym:'2026-12',stores:{riki:{z:4}},period:{v:4,year:2026,month:12},publishedAt:'2026-10-28T11:00:00.000Z'});
  // 同じ月の再公開は上書き（ファイルは増えない）。
  await cloud.publishMonth(o,{viewKey,backupKey,ym:'2026-11',stores:{midori:{z:4,n:['テスト2']}},period:{v:4,year:2026,month:11,members:[]},publishedAt:'2026-10-28T12:00:00.000Z'});
  assert.equal(gh.files.size,5);
  for(const [path,f] of gh.files){assert.ok(!f.text.includes('テスト'),path);assert.ok(!path.includes(viewKey)&&!path.includes(backupKey),path);}
  const reader={fetch:gh.fetch};
  const index=await cloud.loadIndex(reader,viewKey);
  assert.deepEqual(Object.keys(index.months).sort(),['2026-11','2026-12']);
  assert.equal(index.months['2026-11'].publishedAt,'2026-10-28T12:00:00.000Z');
  assert.deepEqual((await cloud.loadMonth(reader,viewKey,'2026-11')).stores.midori.n,['テスト2']);
  assert.equal((await cloud.loadBackup(reader,backupKey,'2026-11')).period.year,2026);
  assert.equal(await cloud.loadBackup(reader,viewKey,'2026-11'),null);
  assert.equal(await cloud.loadMonth(reader,viewKey,'2027-01'),null);
  assert.equal(await cloud.loadIndex(reader,cloud.randomKey()),null);
  // 閲覧はトークンを使わない。
  assert.ok(gh.log.filter(x=>x.method==='GET'&&!x.auth).length>0);

  // 回数制限などでAPIが使えないときは raw から読む。
  const gh2=fakeGitHub({rateLimited:true});for(const [k,v] of gh.files)gh2.files.set(k,v);
  assert.deepEqual((await cloud.loadMonth({fetch:gh2.fetch},viewKey,'2026-12')).stores.riki,{z:4});

  // 鍵の作り直し：新しい鍵で全月が読め、古い鍵では読めない。復元用は残る。
  const newKey=cloud.randomKey();
  assert.equal(await cloud.rotateViewKey(o,viewKey,newKey),2);
  assert.deepEqual((await cloud.loadMonth(reader,newKey,'2026-11')).stores.midori.n,['テスト2']);
  assert.equal(await cloud.loadMonth(reader,viewKey,'2026-11'),null);
  assert.equal(await cloud.loadIndex(reader,viewKey),null);
  assert.ok(await cloud.loadBackup(reader,backupKey,'2026-12'));
  assert.equal(gh.files.size,5);

  // 異常：トークン違い・非公開リポジトリ・通信不可。
  await assert.rejects(cloud.checkSetup({fetch:gh.fetch,token:'wrong'}),/トークンが無効/);
  await assert.rejects(cloud.publishMonth({fetch:gh.fetch,token:'wrong'},{viewKey:newKey,backupKey,ym:'2026-11',stores:{},period:{}}),/トークン/);
  await assert.rejects(cloud.checkSetup({fetch:fakeGitHub({private:true}).fetch,token:'test-token'}),/非公開/);
  await assert.rejects(cloud.loadMonth({fetch:fakeGitHub({offline:true}).fetch},newKey,'2026-11'),/通信/);
  await assert.rejects(cloud.publishMonth(o,{viewKey:'bad',backupKey,ym:'2026-11',stores:{},period:{}}),/鍵が正しくありません/);

  // 競合：保存直前に他で更新されても、最新の版を取り直して保存する。
  const gh3=fakeGitHub();let raced=false;const racing=async(u,init)=>{
    if(!raced&&init&&init.method==='PUT'){raced=true;const p=u.split('/contents/')[1];if(gh3.files.has(p))gh3.files.get(p).sha='changed';}
    return gh3.fetch(u,init);
  };
  const o3={fetch:gh3.fetch,token:gh3.token};
  await cloud.publishMonth(o3,{viewKey,backupKey,ym:'2026-11',stores:{},period:{},publishedAt:'a'});
  raced=false;
  await cloud.publishMonth({fetch:racing,token:gh3.token},{viewKey,backupKey,ym:'2026-11',stores:{x:1},period:{},publishedAt:'b'});
  assert.deepEqual((await cloud.loadMonth({fetch:gh3.fetch},viewKey,'2026-11')).stores,{x:1});

  console.log('share-cloud tests: ok');
})().catch(e=>{console.error(e);process.exit(1);});
