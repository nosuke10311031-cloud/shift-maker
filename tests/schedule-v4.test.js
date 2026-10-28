const assert=require('assert');
const solver=require('../docs/schedule-v4.js');

function plans(rows){
  return {weekday:rows,friday:rows,saturday:rows,sunday:rows};
}
function member(id,extra){return Object.assign({id,name:id,noConsec:0,maxDays:0,employee:false},extra||{});}
function store(targets,rows){
  return {targets:Object.assign({},targets),placed:{},times:{},timeSlots:{},confM:{},confD:{},closedDays:{},workPlans:plans(rows||[{time:'18:00',count:1}])};
}
function input(config){
  const days=config.days||[{d:1,dow:1,holiday:'',we:false}];
  const members=config.members||[member('a')];
  const allTargets=Object.fromEntries(members.map(m=>[m.id,true]));
  return {
    year:2026,month:10,days,members,
    prefs:config.prefs||{},availFrom:config.availFrom||{},specialPrefs:config.specialPrefs||{},
    stores:config.stores||{midori:store(allTargets),riki:store(allTargets)}
  };
}
function rng(seed){return function(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};}
function assigned(result,storeId,d){return Object.keys((result.stores[storeId].placed||{})[d]||{}).filter(id=>result.stores[storeId].placed[d][id]);}
function copy(value){return JSON.parse(JSON.stringify(value));}

// 正常：両店舗を同時に埋め、同じ人を同日に二重配置しない。
{
  const members=[member('both'),member('m'),member('r')];
  const data=input({members,prefs:{both:{1:'◯'},m:{1:'◯'},r:{1:'◯'}},stores:{
    midori:store({both:true,m:true},[{time:'18:00',count:1}]),
    riki:store({both:true,r:true},[{time:'18:00',count:1}])
  }});
  const result=solver.solve(data,{attempts:80,random:rng(1)});
  assert.equal(result.ok,true);
  assert.equal(assigned(result,'midori',1).length,1);
  assert.equal(assigned(result,'riki',1).length,1);
  assert.notEqual(assigned(result,'midori',1)[0],assigned(result,'riki',1)[0]);
  assert.equal(result.score[0],0);
}

// 境界：○が19時、△が18時なら、実際の不足時間を減らす△を最小限使う。
{
  const members=[member('lateCircle'),member('earlyTriangle')];
  const data=input({members,prefs:{lateCircle:{1:'◯'},earlyTriangle:{1:'△'}},availFrom:{lateCircle:{1:'19:00'},earlyTriangle:{1:'18:00'}},stores:{
    midori:store({lateCircle:true,earlyTriangle:true},[{time:'18:00',count:1}]),
    riki:store({},[])
  }});
  const result=solver.solve(data,{scope:['midori'],attempts:60,random:rng(2)});
  assert.equal(result.ok,true);
  assert.deepEqual(assigned(result,'midori',1),['earlyTriangle']);
  assert.equal(result.score[1],0);
  assert.equal(result.usedTriangle,1);
}

// ○と△が同じ品質なら○だけを選ぶ。
{
  const members=[member('circle'),member('triangle')];
  const data=input({members,prefs:{circle:{1:'◯'},triangle:{1:'△'}},availFrom:{circle:{1:'18:00'},triangle:{1:'18:00'}},stores:{
    midori:store({circle:true,triangle:true},[{time:'18:00',count:1}]),riki:store({},[])
  }});
  const result=solver.solve(data,{scope:['midori'],attempts:50,random:rng(3)});
  assert.equal(result.ok,true);
  assert.deepEqual(assigned(result,'midori',1),['circle']);
  assert.equal(result.usedTriangle,0);
}

// 遅れて開始する○は、18時から19時までを遅延として残す。
{
  const data=input({members:[member('late')],prefs:{late:{1:'◯'}},availFrom:{late:{1:'19:00'}},stores:{midori:store({late:true},[{time:'18:00',count:1}]),riki:store({},[])}});
  const result=solver.solve(data,{scope:['midori'],attempts:20,random:rng(4)});
  assert.equal(result.ok,true);
  assert.equal(result.stores.midori.times['late-1'],'19:00');
  assert.equal(result.score[1],60);
}

// 店休日に既存勤務が残る矛盾は自動削除せず停止する。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},stores:{midori:store({a:true}),riki:store({},[])}});
  data.stores.midori.closedDays[1]=true;
  data.stores.midori.placed[1]={a:true};
  const result=solver.solve(data,{scope:['midori'],attempts:20,random:rng(5)});
  assert.equal(result.ok,false);
  assert.match(result.error,/店休日/);
  assert.equal(data.stores.midori.placed[1].a,true);
}

// 特別勤務希望日は確定と同じ扱いのため、店休日で未採用でも別店舗へ自動で入れない。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},specialPrefs:{a:{1:'midori'}},stores:{midori:store({a:true}),riki:store({a:true})}});
  data.stores.midori.closedDays[1]=true;
  const result=solver.solve(data,{mode:'unconfirmed',attempts:20,random:rng(6)});
  assert.equal(result.ok,true);
  assert.equal(assigned(result,'midori',1).length,0);
  assert.equal(assigned(result,'riki',1).length,0);
}

// 確定済み勤務は作り直しでも保持する。
{
  const members=[member('fixed'),member('free')];
  const data=input({members,prefs:{fixed:{1:'◯'},free:{1:'◯'}},stores:{midori:store({fixed:true,free:true},[{time:'18:00',count:1}]),riki:store({},[])}});
  data.stores.midori.placed[1]={fixed:true};data.stores.midori.times['fixed-1']='18:00';data.stores.midori.confM.fixed=true;
  const result=solver.solve(data,{scope:['midori'],mode:'unconfirmed',attempts:30,random:rng(7)});
  assert.equal(result.ok,true);
  assert.equal(result.stores.midori.placed[1].fixed,true);
  assert.equal(result.stores.midori.times['fixed-1'],'18:00');
}

// 同品質の別案がある場合、現在案を避けて再作成できる。
{
  const days=[{d:1,dow:1,holiday:'',we:false},{d:2,dow:2,holiday:'',we:false}];
  const members=[member('a',{maxDays:1}),member('b',{maxDays:1})];
  const data=input({days,members,prefs:{a:{1:'◯',2:'◯'},b:{1:'◯',2:'◯'}},stores:{midori:store({a:true,b:true},[{time:'18:00',count:1}]),riki:store({},[])}});
  const first=solver.solve(data,{scope:['midori'],mode:'unconfirmed',attempts:160,random:rng(8)});
  assert.equal(first.ok,true);
  const second=solver.solve(data,{scope:['midori'],mode:'unconfirmed',attempts:160,avoidSignature:first.signature,random:rng(9)});
  assert.equal(second.ok,true);
  assert.notEqual(second.signature,first.signature);
  assert.deepEqual(second.score,first.score);
}

// 特別勤務は、希望店舗と異なる店舗へ実採用済みでも、店舗・時刻・対応枠を保護する。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},availFrom:{a:{1:'19:00'}},specialPrefs:{a:{1:'midori'}},stores:{midori:store({a:true}),riki:store({a:true})}});
  data.stores.riki.placed[1]={a:true};data.stores.riki.times['a-1']='19:00';data.stores.riki.timeSlots['a-1']='18:00';
  const result=solver.solve(data,{mode:'unconfirmed',attempts:20,random:rng(10)});
  assert.equal(result.ok,true);
  assert.equal(assigned(result,'midori',1).length,0);
  assert.deepEqual(assigned(result,'riki',1),['a']);
  assert.equal(result.stores.riki.times['a-1'],'19:00');
  assert.equal(result.stores.riki.timeSlots['a-1'],'18:00');
}

// 採用中で時刻が空の特別勤務は、勤務を残したまま開始時刻・対応枠だけ補う。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},availFrom:{a:{1:'19:00'}},specialPrefs:{a:{1:'midori'}},stores:{midori:store({a:true}),riki:store({a:true},[])}});
  data.stores.midori.placed[1]={a:true};
  const result=solver.solve(data,{mode:'unconfirmed',attempts:20,random:rng(11)});
  assert.equal(result.ok,true);
  assert.deepEqual(assigned(result,'midori',1),['a']);
  assert.equal(result.stores.midori.times['a-1'],'19:00');
  assert.equal(result.stores.midori.timeSlots['a-1'],'18:00');
}

// 手動で外した特別勤務（未採用）は、作り直しでも自動で戻さない。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},specialPrefs:{a:{1:'midori'}},stores:{midori:store({a:true}),riki:store({a:true})}});
  for(const mode of ['remaining','unconfirmed']){
    const result=solver.solve(data,{mode,attempts:20,random:rng(12)});
    assert.equal(result.ok,true);
    assert.deepEqual(assigned(result,'midori',1),[]);
    assert.deepEqual(assigned(result,'riki',1),[]);
  }
}

// 残り作成では、時刻だけ空の既存未確定勤務を保持しながら補完する。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},availFrom:{a:{1:'19:00'}},stores:{midori:store({a:true}),riki:store({},[])}});
  data.stores.midori.placed[1]={a:true};
  const result=solver.solve(data,{scope:['midori'],mode:'remaining',attempts:20,random:rng(12)});
  assert.equal(result.ok,true);
  assert.equal(result.stores.midori.placed[1].a,true);
  assert.equal(result.stores.midori.times['a-1'],'19:00');
  assert.equal(result.stores.midori.timeSlots['a-1'],'18:00');
}

// 確定済み勤務の時刻が空なら、推測で補わず処理を止める。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},stores:{midori:store({a:true}),riki:store({},[])}});
  data.stores.midori.placed[1]={a:true};data.stores.midori.confD[1]=true;
  const result=solver.solve(data,{scope:['midori'],mode:'unconfirmed',attempts:20,random:rng(13)});
  assert.equal(result.ok,false);
  assert.match(result.error,/確定済み勤務の開始時刻/);
}

// 募集枠・希望開始時刻ともない既存未確定勤務は、空欄のまま成功扱いにしない。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},stores:{midori:store({a:true},[]),riki:store({},[])}});
  data.stores.midori.placed[1]={a:true};
  const result=solver.solve(data,{scope:['midori'],mode:'remaining',attempts:20,random:rng(131)});
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(x=>x.includes('補完対象勤務の開始時刻')));
}

// 最大勤務日数と連勤禁止は店舗をまたいだ既存勤務を含めて判定する。
{
  const days=[{d:1,dow:1,holiday:'',we:false},{d:2,dow:2,holiday:'',we:false}];
  const limited=input({days,members:[member('a',{maxDays:1})],prefs:{a:{1:'◯',2:'◯'}},stores:{midori:store({a:true}),riki:store({a:true},[])}});
  limited.stores.riki.placed[1]={a:true};limited.stores.riki.times['a-1']='18:00';
  let result=solver.solve(limited,{scope:['midori'],attempts:20,random:rng(14)});
  assert.equal(result.ok,true);assert.equal(assigned(result,'midori',2).length,0);
  const consecutive=input({days,members:[member('a',{noConsec:2})],prefs:{a:{1:'◯',2:'◯'}},stores:{midori:store({a:true}),riki:store({a:true},[])}});
  consecutive.stores.riki.placed[1]={a:true};consecutive.stores.riki.times['a-1']='18:00';
  result=solver.solve(consecutive,{scope:['midori'],attempts:20,random:rng(15)});
  assert.equal(result.ok,true);assert.equal(assigned(result,'midori',2).length,0);
}

// 対象外・希望×・他店舗の同日既存勤務は自動配置しない。
{
  const members=[member('off'),member('no'),member('busy')];
  const data=input({members,prefs:{off:{1:'◯'},no:{1:'×'},busy:{1:'◯'}},stores:{midori:store({off:false,no:true,busy:true}),riki:store({busy:true},[])}});
  data.stores.riki.placed[1]={busy:true};data.stores.riki.times['busy-1']='18:00';
  const result=solver.solve(data,{scope:['midori'],attempts:20,random:rng(16)});
  assert.equal(result.ok,true);assert.equal(assigned(result,'midori',1).length,0);
}

// 独立検査は対象・希望×・時刻と、確定／残り保持の時刻・対応枠の改変を検出する。
{
  const data=input({members:[member('a')],prefs:{a:{1:'×'}},stores:{midori:store({a:false}),riki:store({},[])}});
  data.stores.midori.placed[1]={a:true};data.stores.midori.times['a-1']='18:00';data.stores.midori.timeSlots['a-1']='18:00';data.stores.midori.confM.a=true;
  const forged=copy(data.stores);forged.midori.times['a-1']='19:00';forged.midori.timeSlots['a-1']='19:00';
  const trial={stores:forged,autoKeys:new Set(['midori|1|a']),filledTimeKeys:new Set(),fixed:new Set()};
  const errors=solver.validate(data,trial,['midori'],'remaining');
  assert.ok(errors.some(x=>x.includes('対象外')));
  assert.ok(errors.some(x=>x.includes('希望×')));
  assert.ok(errors.some(x=>x.includes('確定済み勤務または時刻')));
  assert.ok(errors.some(x=>x.includes('保持対象の勤務時刻')));
  assert.ok(errors.some(x=>x.includes('保持対象の募集枠')));
}

// 実際に張れる候補辺と日付間の組み直しで、単純な入替で消せる不足を残さない。
{
  const days=[{d:1,dow:1,holiday:'',we:false},{d:2,dow:2,holiday:'',we:false},{d:3,dow:3,holiday:'',we:false}];
  const members=[member('A',{maxDays:1}),member('D'),member('B'),member('C')];
  const midori=store({A:true,D:true,B:false,C:false});midori.closedDays[3]=true;
  const riki=store({D:true},[]);riki.placed[3]={D:true};riki.times['D-3']='18:00';
  const data=input({days,members,prefs:{A:{1:'◯',2:'◯'},D:{1:'×',2:'◯',3:'◯'},B:{1:'◯'},C:{1:'◯'}},stores:{midori,riki}});
  const result=solver.solve(data,{scope:['midori'],mode:'unconfirmed',attempts:20,random:rng(17)});
  assert.equal(result.ok,true);assert.equal(result.score[0],0);
  assert.deepEqual(assigned(result,'midori',1),['A']);
  assert.deepEqual(assigned(result,'midori',2),['D']);
}

// 人数が足りない場合、遅い枠だけを埋めず早い募集枠を優先する。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},availFrom:{a:{1:'19:00'}},stores:{midori:store({a:true},[{time:'18:00',count:1},{time:'19:00',count:1}]),riki:store({},[])}});
  const result=solver.solve(data,{scope:['midori'],attempts:20,random:rng(18)});
  assert.equal(result.ok,true);
  assert.equal(result.stores.midori.timeSlots['a-1'],'18:00');
  assert.equal(result.score[1],60);
}

// 既存勤務に対応枠が記録済みなら、その枠を保護して空いている早い枠を新規配置で埋める。
{
  const members=[member('fixed'),member('free')];
  const data=input({members,prefs:{fixed:{1:'◯'},free:{1:'◯'}},availFrom:{fixed:{1:'19:00'},free:{1:'18:00'}},stores:{midori:store({fixed:true,free:true},[{time:'18:00',count:1},{time:'19:00',count:1}]),riki:store({},[])}});
  data.stores.midori.placed[1]={fixed:true};data.stores.midori.times['fixed-1']='19:00';data.stores.midori.timeSlots['fixed-1']='19:00';
  const result=solver.solve(data,{scope:['midori'],mode:'remaining',attempts:20,random:rng(180)});
  assert.equal(result.ok,true);
  assert.equal(result.stores.midori.timeSlots['fixed-1'],'19:00');
  assert.equal(result.stores.midori.timeSlots['free-1'],'18:00');
  assert.equal(result.score[1],0);
}

// 日付間の交換で遅延だけが改善する場合も、人数が埋まった時点で探索を止めない。
{
  const days=[{d:1,dow:1,holiday:'',we:false},{d:2,dow:2,holiday:'',we:false}];
  const members=[member('A'),member('B',{maxDays:1}),member('C'),member('D')];
  const data=input({days,members,prefs:{A:{1:'◯'},B:{1:'◯',2:'◯'},C:{2:'◯'},D:{1:'◯'}},availFrom:{A:{1:'20:00'},B:{1:'18:00',2:'18:00'},C:{2:'19:00'},D:{1:'20:00'}},stores:{midori:store({A:true,B:true,C:true,D:true}),riki:store({},[])}});
  const result=solver.solve(data,{scope:['midori'],mode:'unconfirmed',attempts:20,random:rng(181)});
  assert.equal(result.ok,true);assert.equal(result.score[0],0);assert.equal(result.score[1],60);
  assert.deepEqual(assigned(result,'midori',1),['B']);
  assert.deepEqual(assigned(result,'midori',2),['C']);
}

// 成功・失敗にかかわらず、検査前の入力データ自体は変更しない。
{
  const data=input({members:[member('a')],prefs:{a:{1:'◯'}},stores:{midori:store({a:true}),riki:store({},[])}});
  const before=copy(data);
  const result=solver.solve(data,{scope:['midori'],attempts:20,random:rng(19)});
  assert.equal(result.ok,true);assert.deepEqual(data,before);
}

// 確定した人・日は勤務の有無も確定済み。どちらの作成方式でも新しい勤務を加えない。
{
  const days=[1,2,3,4].map(d=>({d,dow:d,holiday:'',we:false}));
  const members=[member('conf'),member('free'),member('free2')];
  const all={};members.forEach(m=>{all[m.id]={};days.forEach(x=>all[m.id][x.d]='◯');});
  ['remaining','unconfirmed'].forEach(mode=>{
    const data=input({days,members,prefs:all,stores:{midori:store({conf:true,free:true,free2:true},[{time:'18:00',count:2}]),riki:store({},[])}});
    data.stores.midori.placed={1:{conf:true},3:{free:true}};data.stores.midori.times={'conf-1':'18:00','free-3':'18:00'};
    data.stores.midori.confM={conf:true};data.stores.midori.confD={3:true};
    const result=solver.solve(data,{scope:['midori'],mode,attempts:20,random:rng(200)});
    assert.equal(result.ok,true);
    days.forEach(x=>assert.equal(assigned(result,'midori',x.d).includes('conf'),x.d===1,mode+' '+x.d+'日'));
    assert.deepEqual(assigned(result,'midori',3),['free']);
    assert.equal(result.score[0],1);
    // 検査側でも、確定済みの人・日への追加を検出する。
    const tampered=copy(result);tampered.stores.midori.placed[2]=Object.assign({},tampered.stores.midori.placed[2],{conf:true});tampered.stores.midori.times['conf-2']='18:00';
    const errors=solver.validate(data,{stores:tampered.stores,autoKeys:new Set(['midori|2|conf']),filledTimeKeys:new Set()},['midori'],mode);
    assert.ok(errors.some(e=>e.indexOf('確定済みの人・日へ勤務が追加')>=0));
  });
}

// 取込時に了承した特別勤務が最大日数・連勤を超えていても、作り直し全体を失敗させず残す。
{
  const days=[1,2,3].map(d=>({d,dow:d,holiday:'',we:false}));
  const members=[member('sp',{maxDays:1,noConsec:2})];
  const data=input({days,members,prefs:{sp:{1:'◯',2:'◯',3:'◯'}},specialPrefs:{sp:{1:'midori',2:'midori'}},stores:{midori:store({sp:true}),riki:store({},[])}});
  data.stores.midori.placed={1:{sp:true},2:{sp:true}};
  const result=solver.solve(data,{scope:['midori'],mode:'unconfirmed',attempts:20,random:rng(201)});
  assert.equal(result.ok,true);
  assert.deepEqual([1,2,3].map(d=>assigned(result,'midori',d).length),[1,1,0]);
}

// 未採用の特別勤務希望日は確定・対象外にかかわらず自動で入れず、他の人で作成を続ける。
{
  const days=[1,2].map(d=>({d,dow:d,holiday:'',we:false}));
  const members=[member('c'),member('t'),member('o')];
  const data=input({days,members,prefs:{c:{1:'◯',2:'◯'},t:{1:'◯',2:'◯'},o:{1:'◯',2:'◯'}},specialPrefs:{c:{1:'midori'},t:{2:'midori'}},stores:{midori:store({c:true,o:true}),riki:store({},[])}});
  data.stores.midori.confM={c:true};
  const result=solver.solve(data,{scope:['midori'],mode:'unconfirmed',attempts:20,random:rng(202)});
  assert.equal(result.ok,true);
  assert.deepEqual(assigned(result,'midori',1),['o']);
  assert.deepEqual(assigned(result,'midori',2),['o']);
  assert.equal(result.warnings.length,0);
}

// 特別勤務希望日は両店舗とも確定と同じ扱い。採用中は募集0人でも外さず、未採用の日は他店舗へも入れない。
{
  const days=[1,2].map(d=>({d,dow:d,holiday:'',we:false}));
  const members=[member('sp'),member('o')];
  const data=input({days,members,prefs:{sp:{1:'◯',2:'◯'},o:{1:'◯',2:'×'}},specialPrefs:{sp:{1:'midori',2:'midori'}},stores:{midori:store({sp:true,o:true},[{time:'18:00',count:0}]),riki:store({sp:true},[{time:'18:00',count:1}])}});
  data.stores.midori.placed={1:{sp:true}};data.stores.midori.times={'sp-1':'18:00'};
  for(const mode of ['remaining','unconfirmed']){
    const result=solver.solve(data,{mode,attempts:20,random:rng(203)});
    assert.equal(result.ok,true);
    assert.deepEqual(assigned(result,'midori',1),['sp']);
    assert.equal(result.stores.midori.times['sp-1'],'18:00');
    assert.deepEqual(assigned(result,'riki',2),[]);
    assert.deepEqual(assigned(result,'midori',2),[]);
  }
  // 独立検査は、特別勤務希望日への自動追加と自動削除を検出する。
  const ok=solver.solve(data,{mode:'unconfirmed',attempts:20,random:rng(204)});
  const added=copy(ok.stores);added.riki.placed[2]={sp:true};added.riki.times['sp-2']='18:00';
  assert.ok(solver.validate(data,{stores:added,autoKeys:new Set(['riki|2|sp']),filledTimeKeys:new Set()},['midori','riki'],'unconfirmed').some(e=>e.indexOf('特別勤務希望日の勤務が変更')>=0));
  const removed=copy(ok.stores);removed.midori.placed[1]={};
  assert.ok(solver.validate(data,{stores:removed,autoKeys:new Set(),filledTimeKeys:new Set()},['midori','riki'],'unconfirmed').some(e=>e.indexOf('特別勤務希望日の勤務が変更')>=0));
}

// ×の日に残した希望開始時刻は、既存勤務の開始時刻補完に使わない。
{
  const members=[member('x')];
  const data=input({members,prefs:{x:{}},availFrom:{x:{1:'20:00'}},stores:{midori:store({x:true}),riki:store({},[])}});
  data.stores.midori.placed={1:{x:true}};
  const result=solver.solve(data,{scope:['midori'],mode:'remaining',attempts:20,random:rng(206)});
  assert.equal(result.ok,true);
  assert.equal(result.stores.midori.times['x-1'],'18:00');
  assert.equal(data.availFrom.x[1],'20:00');
}

console.log('schedule-v4 tests: ok');
