const assert=require('assert');
const fs=require('fs');
const vm=require('vm');

const html=fs.readFileSync(require.resolve('../docs/admin.html'),'utf8');
const start=html.indexOf("const STORE_PREFIX='shiftmaker_v4_';");
const end=html.indexOf("const WD=",start);
const inspectStart=html.indexOf('function inspectSavedPeriod(');
const inspectEnd=html.indexOf('function latestValidPeriod(',inspectStart);
assert.ok(start>=0&&end>start,'admin.html の保存処理を取得できません');
assert.ok(inspectStart>=0&&inspectEnd>inspectStart,'admin.html の保存形式検査を取得できません');
const source=html.slice(start,end)+'\nconst STORE_LABEL={midori:"みどり",riki:"リキ"};\n'+html.slice(inspectStart,inspectEnd)+'\nglobalThis.__store=store;globalThis.__monthKey=monthKey;globalThis.__inspectSavedPeriod=inspectSavedPeriod;';

class FakeStorage{
  constructor(limit=Infinity){Object.defineProperty(this,'limit',{value:limit,writable:true,enumerable:false});Object.defineProperty(this,'failure',{value:null,writable:true,enumerable:false});}
  getItem(key){return Object.prototype.hasOwnProperty.call(this,key)?this[key]:null;}
  setItem(key,value){
    if(this.failure)throw this.failure;
    value=String(value);
    const current=Object.keys(this).reduce((n,k)=>n+String(this[k]).length,0)-(Object.prototype.hasOwnProperty.call(this,key)?String(this[key]).length:0);
    if(current+value.length>this.limit){const error=new Error('quota');error.name='QuotaExceededError';throw error;}
    this[key]=value;
  }
  removeItem(key){delete this[key];}
}

function setup(storage){
  const context={localStorage:storage,uid:()=> 'testid',console};
  vm.createContext(context);vm.runInContext(source,context);
  return {store:context.__store,inspect:context.__inspectSavedPeriod};
}
function period(year,month,pad=''){return {v:4,year,month,stores:{midori:{},riki:{}},pad};}

// 未作成・破損・正常を区別し、破損原文を保持する。
{
  const storage=new FakeStorage(),{store}=setup(storage);
  assert.equal(store.read(2026,1).state,'missing');
  storage.setItem('shiftmaker_v4_2026-01','{broken');
  const broken=store.read(2026,1);assert.equal(broken.state,'corrupt');assert.equal(broken.raw,'{broken');
  storage.setItem('shiftmaker_v4_2026-01',JSON.stringify(period(2026,1)));
  assert.equal(store.read(2026,1).state,'ok');
}

// 月一覧には正しい年月キーだけを含める。
{
  const storage=new FakeStorage(),{store}=setup(storage);
  storage.setItem('shiftmaker_v4_2026-01','{}');storage.setItem('shiftmaker_v4_2026-13','{}');storage.setItem('shiftmaker_v4_note','{}');
  storage.setItem('shiftmaker_v4_meta','{}');
  assert.deepEqual(Array.from(store.months()),['2026-01']);
}

// 管理情報のJSONが読めても形式不正なら、正常扱いせず保存を停止する。
{
  const storage=new FakeStorage(),{store}=setup(storage);
  storage.setItem('shiftmaker_v4_meta','null');
  const meta=store.meta();assert.equal(meta.active,'');assert.equal(store.metaError,true);assert.equal(store.saveMeta(meta).ok,false);
}

// 通常の書込拒否では、古い月を削除しない。
{
  const storage=new FakeStorage(),{store}=setup(storage),old=JSON.stringify(period(2026,1));
  storage.setItem('shiftmaker_v4_2026-01',old);
  const error=new Error('denied');error.name='SecurityError';storage.failure=error;
  const result=store.save(period(2026,2));storage.failure=null;
  assert.equal(result.ok,false);assert.equal(result.reason,'write');assert.equal(storage.getItem('shiftmaker_v4_2026-01'),old);
}

// 容量不足時だけ、最も古い過去月から削除して現在月を保存する。
{
  const storage=new FakeStorage(),{store}=setup(storage),jan=JSON.stringify(period(2026,1,'x'.repeat(80))),feb=JSON.stringify(period(2026,2,'x'.repeat(80)));
  storage.setItem('shiftmaker_v4_2026-01',jan);storage.setItem('shiftmaker_v4_2026-02',feb);
  const next=period(2026,3,'x'.repeat(100));storage.limit=jan.length+feb.length+20;
  const result=store.save(next);
  assert.equal(result.ok,true);assert.deepEqual(Array.from(result.removed),['2026-01']);
  assert.equal(storage.getItem('shiftmaker_v4_2026-01'),null);assert.equal(storage.getItem('shiftmaker_v4_2026-02'),feb);
  assert.deepEqual(JSON.parse(storage.getItem('shiftmaker_v4_2026-03')),next);
}

// 全て削除しても保存できない場合は、削除した月を元へ戻して失敗を明示する。
{
  const storage=new FakeStorage(),{store}=setup(storage),jan=JSON.stringify(period(2026,1,'x'.repeat(20))),feb=JSON.stringify(period(2026,2,'x'.repeat(20)));
  storage.setItem('shiftmaker_v4_2026-01',jan);storage.setItem('shiftmaker_v4_2026-02',feb);
  storage.limit=jan.length+feb.length;
  const result=store.save(period(2026,3,'x'.repeat(1000)));
  assert.equal(result.ok,false);assert.equal(result.reason,'quota');assert.equal(result.recoveryFailed,false);
  assert.equal(storage.getItem('shiftmaker_v4_2026-01'),jan);assert.equal(storage.getItem('shiftmaker_v4_2026-02'),feb);
  assert.equal(storage.getItem('shiftmaker_v4_2026-03'),null);
}

// JSONとして読めても、年月不一致・不完全な店舗・募集設定は正常扱いしない。
{
  const storage=new FakeStorage(),{inspect}=setup(storage);
  const plans={weekday:[],friday:[],saturday:[],sunday:[]};
  const completeStore=()=>({targets:{},placed:{},times:{},timeSlots:{},confM:{},confD:{},closedDays:{},workPlans:plans});
  const valid={v:4,year:2026,month:10,members:[],prefs:{},availFrom:{},specialPrefs:{},stores:{midori:completeStore(),riki:completeStore()}};
  assert.equal(inspect({state:'ok',value:valid},2026,10).state,'ok');
  assert.equal(inspect({state:'ok',value:valid},2026,11).state,'invalid');
  const brokenStore=JSON.parse(JSON.stringify(valid));brokenStore.stores.midori='壊れた値';
  assert.equal(inspect({state:'ok',value:brokenStore},2026,10).state,'invalid');
  const brokenPlans=JSON.parse(JSON.stringify(valid));brokenPlans.stores.midori.workPlans.weekday='壊れた値';
  assert.equal(inspect({state:'ok',value:brokenPlans},2026,10).state,'invalid');
  for(const badCount of [null,'',false]){
    const brokenCount=JSON.parse(JSON.stringify(valid));brokenCount.stores.midori.workPlans.weekday=[{time:'18:00',count:badCount}];
    assert.equal(inspect({state:'ok',value:brokenCount},2026,10).state,'invalid');
  }
  const brokenMembers=JSON.parse(JSON.stringify(valid));brokenMembers.members={};
  assert.equal(inspect({state:'ok',value:brokenMembers},2026,10).state,'invalid');
  const brokenYear=JSON.parse(JSON.stringify(valid));brokenYear.year='2026';
  assert.equal(inspect({state:'ok',value:brokenYear},2026,10).state,'invalid');
}

console.log('admin storage tests: ok');
