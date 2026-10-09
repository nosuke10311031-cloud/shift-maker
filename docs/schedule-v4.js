(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.ShiftV4Solver=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  var STORE_IDS=['midori','riki'];
  var PLAN_TYPES=['weekday','friday','saturday','sunday'];

  function clone(value){return JSON.parse(JSON.stringify(value));}
  function timeToMinutes(value){
    var parts=String(value||'').split(':').map(Number);
    return parts.length===2&&isFinite(parts[0])&&isFinite(parts[1])?parts[0]*60+parts[1]:0;
  }
  function minutesToTime(value){return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');}
  function lexCompare(a,b){
    for(var i=0;i<Math.max(a.length,b.length);i++){
      var av=a[i]||0,bv=b[i]||0;
      if(av<bv)return -1;
      if(av>bv)return 1;
    }
    return 0;
  }
  function planType(day){
    if(day.holiday)return 'saturday';
    if(day.dow===0)return 'sunday';
    if(day.dow===5)return 'friday';
    if(day.dow===6)return 'saturday';
    return 'weekday';
  }
  function isClosed(store,d){return !!(store.closedDays&&store.closedDays[d]);}
  function slotsFor(store,day){
    if(isClosed(store,day.d))return [];
    var rows=(store.workPlans&&store.workPlans[planType(day)])||[],out=[];
    rows.forEach(function(row){
      var count=Math.max(0,parseInt(row.count)||0);
      for(var i=0;i<count;i++)out.push({required:String(row.time||''),requiredMin:timeToMinutes(row.time),slotIndex:i});
    });
    return out.sort(function(a,b){return a.requiredMin-b.requiredMin;});
  }
  function isIn(stores,storeId,d,mid){return !!(stores[storeId].placed[d]&&stores[storeId].placed[d][mid]);}
  function worksOn(stores,d,mid){return STORE_IDS.some(function(id){return isIn(stores,id,d,mid);});}
  function countDays(stores,days,mid){return days.reduce(function(n,day){return n+(worksOn(stores,day.d,mid)?1:0);},0);}
  function maxRun(stores,days,mid){
    var best=0,run=0;
    days.forEach(function(day){run=worksOn(stores,day.d,mid)?run+1:0;if(run>best)best=run;});
    return best;
  }
  function wouldExceedRun(stores,days,mid,d,limit){
    if(!limit)return false;
    var p=d-1,q=d+1,len=1,dim=days.length;
    while(p>=1&&worksOn(stores,p,mid)){len++;p--;}
    while(q<=dim&&worksOn(stores,q,mid)){len++;q++;}
    return len>=limit;
  }
  function actualStart(input,member,day,requiredMin){
    if(member.employee)return 13*60;
    var value=input.availFrom&&input.availFrom[member.id]&&input.availFrom[member.id][day.d];
    var available=timeToMinutes(value);
    return Math.max(requiredMin,available||requiredMin);
  }
  function prefOf(input,mid,d){return (input.prefs&&input.prefs[mid]&&input.prefs[mid][d])||'×';}
  function confirmed(store,d,mid){return !!((store.confM&&store.confM[mid])||(store.confD&&store.confD[d]));}
  function assignmentKey(storeId,d,mid){return storeId+'|'+d+'|'+mid;}
  function parseAssignmentKey(key){var p=String(key).split('|');return {storeId:p[0],d:parseInt(p[1]),mid:p.slice(2).join('|')};}
  function own(object,key){return Object.prototype.hasOwnProperty.call(object||{},key);}
  function specialActualStore(input,mid,d){
    var found=STORE_IDS.filter(function(id){return isIn(input.stores,id,d,mid);});
    return found.length===1?found[0]:'';
  }
  function earliestPlanTime(store,day){
    var rows=(store.workPlans&&store.workPlans[planType(day)])||[],values=rows.map(function(row){return String(row.time||'');}).filter(Boolean);
    values.sort(function(a,b){return timeToMinutes(a)-timeToMinutes(b);});
    return values[0]||'';
  }

  function prepareBase(input,scope,mode){
    var stores=clone(input.stores),scopeSet=new Set(scope),fixed=new Set(),warnings=[],addedSpecialKeys=new Set();
    STORE_IDS.forEach(function(id){
      var store=stores[id];
      store.placed=store.placed||{};store.times=store.times||{};store.timeSlots=store.timeSlots||{};
      if(scopeSet.has(id)&&mode==='unconfirmed'){
        var placed={},times={},timeSlots={};
        input.days.forEach(function(day){
          input.members.forEach(function(member){
            var actual=specialActualStore(input,member.id,day.d);
            var keep=confirmed(store,day.d,member.id)||(actual===id&&input.specialPrefs&&input.specialPrefs[member.id]&&input.specialPrefs[member.id][day.d]);
            if(!isIn(stores,id,day.d,member.id)||!keep)return;
            if(!placed[day.d])placed[day.d]={};
            placed[day.d][member.id]=true;
            var key=member.id+'-'+day.d;
            if(store.times[key])times[key]=store.times[key];
            if(store.timeSlots[key])timeSlots[key]=store.timeSlots[key];
          });
        });
        store.placed=placed;store.times=times;store.timeSlots=timeSlots;
      }
    });

    // 実採用済みの特別勤務は上で実店舗ごと保持する。未採用だけ希望店舗へ加える。
    if(mode==='unconfirmed'){
      Object.keys(input.specialPrefs||{}).forEach(function(mid){
        Object.keys(input.specialPrefs[mid]||{}).forEach(function(rawDay){
          var d=parseInt(rawDay),storeId=input.specialPrefs[mid][rawDay];
          if(!scopeSet.has(storeId))return;
          if(isClosed(stores[storeId],d)){
            warnings.push(d+'日の特別勤務希望は希望店舗が店休日のため未採用です。');
            return;
          }
          if(worksOn(stores,d,mid))return;
          stores[storeId].placed[d]=Object.assign({},stores[storeId].placed[d]||{},Object.fromEntries([[mid,true]]));
          addedSpecialKeys.add(assignmentKey(storeId,d,mid));
          var member=input.members.find(function(x){return x.id===mid;});
          if(member&&member.employee)stores[storeId].times[mid+'-'+d]='13:00';
        });
      });
    }

    STORE_IDS.forEach(function(id){
      Object.keys(stores[id].placed||{}).forEach(function(rawDay){
        Object.keys(stores[id].placed[rawDay]||{}).forEach(function(mid){
          if(stores[id].placed[rawDay][mid])fixed.add(assignmentKey(id,parseInt(rawDay),mid));
        });
      });
    });
    return {stores:stores,fixed:fixed,warnings:warnings,addedSpecialKeys:addedSpecialKeys};
  }

  // 小さい日次グラフ用の最小費用最大流。最大人数を満たした上で費用を最小化する。
  function minCostMatching(members,slots,edgeFactory){
    var count=1+members.length+slots.length+1,source=0,sink=count-1,graph=Array.from({length:count},function(){return [];});
    function addEdge(from,to,cap,cost,meta){
      var f={to:to,rev:graph[to].length,cap:cap,cost:cost,meta:meta||null,original:cap};
      var r={to:from,rev:graph[from].length,cap:0,cost:-cost,meta:null,original:0};
      graph[from].push(f);graph[to].push(r);
      return f;
    }
    members.forEach(function(_,i){addEdge(source,1+i,1,0);});
    slots.forEach(function(_,j){addEdge(1+members.length+j,sink,1,0);});
    var refs=[];
    members.forEach(function(member,i){
      slots.forEach(function(slot,j){
        var edge=edgeFactory(member,slot);
        if(!edge)return;
        var ref=addEdge(1+i,1+members.length+j,1,edge.cost,{member:member,slot:slot,actualMin:edge.actualMin,pref:edge.pref});
        refs.push(ref);
      });
    });
    while(true){
      var dist=Array(count).fill(Infinity),prevNode=Array(count).fill(-1),prevEdge=Array(count).fill(-1);dist[source]=0;
      for(var step=0;step<count-1;step++){
        var changed=false;
        for(var v=0;v<count;v++){
          if(!isFinite(dist[v]))continue;
          graph[v].forEach(function(edge,ei){
            if(edge.cap<=0)return;
            var nd=dist[v]+edge.cost;
            if(nd<dist[edge.to]){dist[edge.to]=nd;prevNode[edge.to]=v;prevEdge[edge.to]=ei;changed=true;}
          });
        }
        if(!changed)break;
      }
      if(!isFinite(dist[sink]))break;
      var node=sink;
      while(node!==source){var pn=prevNode[node],pe=prevEdge[node];graph[pn][pe].cap--;graph[node][graph[pn][pe].rev].cap++;node=pn;}
    }
    return refs.filter(function(edge){return edge.original===1&&edge.cap===0;}).map(function(edge){return edge.meta;});
  }

  function occupyFixed(input,stores,day,scope,slotsByStore,filledTimeKeys){
    var occupied=new Set();
    STORE_IDS.forEach(function(id){
      input.members.forEach(function(member){if(isIn(stores,id,day.d,member.id))occupied.add(member.id);});
    });
    scope.forEach(function(id){
      var slots=slotsByStore[id],fixedWorkers=input.members.filter(function(member){return isIn(stores,id,day.d,member.id);});
      fixedWorkers.sort(function(a,b){
        var ak=a.employee?13*60:timeToMinutes(stores[id].times[a.id+'-'+day.d]||(input.availFrom[a.id]&&input.availFrom[a.id][day.d]));
        var bk=b.employee?13*60:timeToMinutes(stores[id].times[b.id+'-'+day.d]||(input.availFrom[b.id]&&input.availFrom[b.id][day.d]));
        return ak-bk;
      });
      fixedWorkers.forEach(function(member){
        var key=member.id+'-'+day.d,stored=stores[id].times[key],available=input.availFrom&&input.availFrom[member.id]&&input.availFrom[member.id][day.d];
        if(!slots.length){
          if(!stored){
            var fallback=member.employee?'13:00':(available||earliestPlanTime(stores[id],day));
            if(fallback)stores[id].times[key]=fallback;
            filledTimeKeys.add(assignmentKey(id,day.d,member.id));
          }
          return;
        }
        var actual=stored?timeToMinutes(stored):actualStart(input,member,day,slots[0].requiredMin);
        var recordedSlot=stores[id].timeSlots[key],bestIndex=recordedSlot?slots.findIndex(function(slot){return slot.required===recordedSlot;}):-1,bestCost=Infinity;
        if(bestIndex>=0)actual=stored?actual:actualStart(input,member,day,slots[bestIndex].requiredMin);
        else slots.forEach(function(slot,index){
          var candidateActual=stored?actual:actualStart(input,member,day,slot.requiredMin);
          var cost=slot.priorityRank*1000000000000+Math.max(0,candidateActual-slot.requiredMin);
          if(cost<bestCost){bestCost=cost;bestIndex=index;actual=candidateActual;}
        });
        var matched=slots.splice(bestIndex,1)[0];
        if(!stored){
          stores[id].times[key]=member.employee?'13:00':minutesToTime(actual);
          stores[id].timeSlots[key]=matched.required;
          filledTimeKeys.add(assignmentKey(id,day.d,member.id));
        }
      });
    });
    return occupied;
  }

  function candidateEdge(input,stores,day,member,slot,allowTriangle,counts){
    var store=stores[slot.storeId],pref=prefOf(input,member.id,day.d);
    var requested=input.specialPrefs&&input.specialPrefs[member.id]&&input.specialPrefs[member.id][day.d];
    if(requested&&requested!==slot.storeId)return null;
    if(!store.targets||!store.targets[member.id])return null;
    if(pref!=='◯'&&!(allowTriangle&&pref==='△'))return null;
    if(member.maxDays>0&&counts[member.id]>=member.maxDays)return null;
    if(wouldExceedRun(stores,input.days,member.id,day.d,member.noConsec||0))return null;
    var actual=actualStart(input,member,day,slot.requiredMin);
    return {actualMin:actual,pref:pref,delay:Math.max(0,actual-slot.requiredMin)};
  }

  function slotsByStoreFor(stores,day,scope){
    var result={},all=[];
    scope.forEach(function(id){
      result[id]=slotsFor(stores[id],day).map(function(slot,index){return Object.assign({storeId:id,unique:id+'-'+day.d+'-'+index},slot);});
      all=all.concat(result[id]);
    });
    var times=Array.from(new Set(all.map(function(slot){return slot.requiredMin;}))).sort(function(a,b){return a-b;});
    all.forEach(function(slot){slot.priorityRank=times.indexOf(slot.requiredMin);});
    return result;
  }

  function assignDay(input,stores,day,scope,allowTriangle,random,autoKeys,filledTimeKeys){
    var slotsByStore=slotsByStoreFor(stores,day,scope);
    var occupied=occupyFixed(input,stores,day,scope,slotsByStore,filledTimeKeys);
    var residual=scope.reduce(function(all,id){return all.concat(slotsByStore[id]);},[]);
    if(!residual.length)return;
    var counts={},halfCounts={A:{},B:{}};
    input.members.forEach(function(member){counts[member.id]=countDays(stores,input.days,member.id);halfCounts.A[member.id]=0;halfCounts.B[member.id]=0;});
    input.days.forEach(function(x){input.members.forEach(function(member){if(worksOn(stores,x.d,member.id))halfCounts[x.d<=Math.ceil(input.days.length/2)?'A':'B'][member.id]++;});});
    var members=input.members.filter(function(member){return !occupied.has(member.id);});
    var matches=minCostMatching(members,residual,function(member,slot){
      var edge=candidateEdge(input,stores,day,member,slot,allowTriangle,counts);
      if(!edge)return null;
      var half=day.d<=Math.ceil(input.days.length/2)?'A':'B';
      var cost=slot.priorityRank*1000000000000+edge.delay*1000000+(edge.pref==='△'?10000:0)+counts[member.id]*100+halfCounts[half][member.id]*20+Math.floor(random()*20);
      return {cost:cost,actualMin:edge.actualMin,pref:edge.pref};
    });
    matches.forEach(function(match){
      var id=match.slot.storeId,mid=match.member.id,d=day.d,key=mid+'-'+d;
      stores[id].placed[d]=Object.assign({},stores[id].placed[d]||{},Object.fromEntries([[mid,true]]));
      stores[id].times[key]=match.member.employee?'13:00':minutesToTime(match.actualMin);
      stores[id].timeSlots[key]=match.slot.required;
      autoKeys.add(assignmentKey(id,d,mid));
    });
  }

  function daySlack(input,stores,day,scope,allowTriangle){
    var slotsByStore=slotsByStoreFor(stores,day,scope),slots=scope.reduce(function(all,id){return all.concat(slotsByStore[id]);},[]),counts={};
    input.members.forEach(function(member){counts[member.id]=countDays(stores,input.days,member.id);});
    var occupied=new Set();STORE_IDS.forEach(function(id){input.members.forEach(function(member){if(isIn(stores,id,day.d,member.id))occupied.add(member.id);});});
    var edgeCount=0;
    input.members.forEach(function(member){
      if(occupied.has(member.id))return;
      slots.forEach(function(slot){if(candidateEdge(input,stores,day,member,slot,allowTriangle,counts))edgeCount++;});
    });
    return edgeCount-slots.length;
  }

  function buildTrial(input,scope,mode,allowTriangle,random){
    var prep=prepareBase(input,scope,mode),stores=prep.stores,fixed=prep.fixed;
    var autoKeys=new Set(prep.addedSpecialKeys),filledTimeKeys=new Set();
    // 先に同点順を乱し、実際に張れる候補辺が少ない日から安定して処理する。
    var order=input.days.map(function(day){return {day:day,tie:random()};}).sort(function(a,b){
      return daySlack(input,stores,a.day,scope,allowTriangle)-daySlack(input,stores,b.day,scope,allowTriangle)||(a.tie-b.tie);
    }).map(function(item){return item.day;});
    order.forEach(function(day){assignDay(input,stores,day,scope,allowTriangle,random,autoKeys,filledTimeKeys);});
    return {stores:stores,fixed:fixed,autoKeys:autoKeys,filledTimeKeys:filledTimeKeys,warnings:prep.warnings};
  }

  function scoreResult(input,stores,scope){
    var shortfall=0,delay=0,triangles=0,storeStats={midori:{need:0,short:0},riki:{need:0,short:0}};
    input.days.forEach(function(day){
      scope.forEach(function(id){
        var slots=slotsFor(stores[id],day).sort(function(a,b){return a.requiredMin-b.requiredMin;});
        var starts=input.members.filter(function(member){return isIn(stores,id,day.d,member.id);}).map(function(member){
          var value=stores[id].times[member.id+'-'+day.d]||(member.employee?'13:00':((input.availFrom[member.id]&&input.availFrom[member.id][day.d])||''));
          return {member:member,min:timeToMinutes(value)};
        }).sort(function(a,b){return a.min-b.min;});
        var matched=Math.min(slots.length,starts.length),missing=slots.length-matched;
        shortfall+=missing;storeStats[id].need+=slots.length;storeStats[id].short+=missing;
        for(var i=0;i<matched;i++)delay+=Math.max(0,(starts[i].min||slots[i].requiredMin)-slots[i].requiredMin);
        starts.forEach(function(item){if(prefOf(input,item.member.id,day.d)==='△')triangles++;});
      });
    });
    var imbalance=0;
    if(scope.length===2){
      var m=storeStats.midori,r=storeStats.riki;
      imbalance=Math.abs(m.short*Math.max(1,r.need)-r.short*Math.max(1,m.need));
    }
    var assignedTotal=0,wishTotal=0,counts={},wish={},halfDev=0,fairness=0;
    input.members.forEach(function(member){counts[member.id]=countDays(stores,input.days,member.id);assignedTotal+=counts[member.id];wish[member.id]=0;});
    input.days.forEach(function(day){input.members.forEach(function(member){
      var can=scope.some(function(id){return !isClosed(stores[id],day.d)&&stores[id].targets&&stores[id].targets[member.id];});
      if(can){var pref=prefOf(input,member.id,day.d);wish[member.id]+=pref==='◯'?2:pref==='△'?1:0;}
    });});
    Object.keys(wish).forEach(function(mid){wishTotal+=wish[mid];});
    input.members.forEach(function(member){
      var target=wishTotal?assignedTotal*wish[member.id]/wishTotal:0;
      fairness+=Math.round(Math.abs(counts[member.id]-target)*100);
      var a=0,b=0;input.days.forEach(function(day){if(worksOn(stores,day.d,member.id))(day.d<=Math.ceil(input.days.length/2)?a++:b++);});
      halfDev+=Math.abs(a-b);
    });
    return [shortfall,delay,triangles,imbalance,fairness,halfDev];
  }

  function signature(stores,scope){
    var values=[];
    scope.forEach(function(id){
      Object.keys(stores[id].placed||{}).sort(function(a,b){return Number(a)-Number(b);}).forEach(function(d){
        Object.keys(stores[id].placed[d]||{}).sort().forEach(function(mid){
          if(stores[id].placed[d][mid])values.push(id+':'+d+':'+mid+':'+(stores[id].times[mid+'-'+d]||''));
        });
      });
    });
    return values.join('|');
  }

  function dayHasShortfall(input,stores,day,scope){
    return scope.some(function(id){
      var slots=slotsFor(stores[id],day).sort(function(a,b){return a.requiredMin-b.requiredMin;});
      var starts=input.members.filter(function(member){return isIn(stores,id,day.d,member.id);}).map(function(member){
        var key=member.id+'-'+day.d,value=stores[id].times[key]||(member.employee?'13:00':((input.availFrom[member.id]&&input.availFrom[member.id][day.d])||''));
        return timeToMinutes(value);
      }).sort(function(a,b){return a-b;});
      if(starts.length<slots.length)return true;
      for(var i=0;i<slots.length;i++)if((starts[i]||slots[i].requiredMin)>slots[i].requiredMin)return true;
      return false;
    });
  }

  function rebuildDayPair(input,trial,scope,allowTriangle,random,first,second){
    var stores=clone(trial.stores),autoKeys=new Set(trial.autoKeys),filledTimeKeys=new Set(trial.filledTimeKeys||[]),days=new Set([first.d,second.d]);
    Array.from(autoKeys).forEach(function(key){
      var item=parseAssignmentKey(key);
      if(!days.has(item.d)||trial.fixed.has(key))return;
      var row=Object.assign({},stores[item.storeId].placed[item.d]||{}),timeKey=item.mid+'-'+item.d;
      delete row[item.mid];stores[item.storeId].placed[item.d]=row;
      delete stores[item.storeId].times[timeKey];delete stores[item.storeId].timeSlots[timeKey];
      autoKeys.delete(key);filledTimeKeys.delete(key);
    });
    assignDay(input,stores,first,scope,allowTriangle,random,autoKeys,filledTimeKeys);
    assignDay(input,stores,second,scope,allowTriangle,random,autoKeys,filledTimeKeys);
    return {stores:stores,fixed:trial.fixed,autoKeys:autoKeys,filledTimeKeys:filledTimeKeys,warnings:trial.warnings||[]};
  }

  // 不足日の割当と別日の割当を一度外し、2日をまとめて組み直す軽量な局所改善。
  function localImprove(input,trial,scope,allowTriangle,random){
    var current=trial,currentScore=scoreResult(input,current.stores,scope),passes=0,changed=true,checks=0,maxChecks=180;
    while(changed&&passes<2&&checks<maxChecks){
      changed=false;passes++;
      var shortageDays=input.days.filter(function(day){return dayHasShortfall(input,current.stores,day,scope);});
      outer:for(var i=0;i<shortageDays.length;i++){
        for(var j=0;j<input.days.length;j++){
          var shortage=shortageDays[i],other=input.days[j];if(shortage.d===other.d)continue;
          if(checks++>=maxChecks)break outer;
          var candidate=rebuildDayPair(input,current,scope,allowTriangle,random,shortage,other);
          var score=scoreResult(input,candidate.stores,scope);
          if(lexCompare(score,currentScore)<0){current=candidate;currentScore=score;changed=true;break outer;}
        }
      }
    }
    return current;
  }

  function protectedBase(input,scope,mode){
    var stores=clone(input.stores),scopeSet=new Set(scope);
    STORE_IDS.forEach(function(id){
      stores[id].placed=stores[id].placed||{};stores[id].times=stores[id].times||{};stores[id].timeSlots=stores[id].timeSlots||{};
      if(mode!=='unconfirmed'||!scopeSet.has(id))return;
      var placed={},times={},timeSlots={};
      input.days.forEach(function(day){input.members.forEach(function(member){
        var actual=specialActualStore(input,member.id,day.d);
        var special=actual===id&&input.specialPrefs&&input.specialPrefs[member.id]&&input.specialPrefs[member.id][day.d];
        if(!isIn(input.stores,id,day.d,member.id)||(!confirmed(input.stores[id],day.d,member.id)&&!special))return;
        placed[day.d]=Object.assign({},placed[day.d]||{},Object.fromEntries([[member.id,true]]));
        var key=member.id+'-'+day.d;
        if(own(input.stores[id].times,key))times[key]=input.stores[id].times[key];
        if(own(input.stores[id].timeSlots,key))timeSlots[key]=input.stores[id].timeSlots[key];
      });});
      stores[id].placed=placed;stores[id].times=times;stores[id].timeSlots=timeSlots;
    });
    return stores;
  }

  function validate(input,trial,scope,mode){
    var errors=[],stores=trial.stores,base=protectedBase(input,scope,mode),scopeSet=new Set(scope);
    input.days.forEach(function(day){
      input.members.forEach(function(member){
        var ids=STORE_IDS.filter(function(id){return isIn(stores,id,day.d,member.id);});
        if(ids.length>1)errors.push(day.d+'日に同じ人が両店舗へ配置されています。');
        ids.forEach(function(id){
          var key=assignmentKey(id,day.d,member.id);
          if(isClosed(stores[id],day.d))errors.push(day.d+'日の店休日に勤務が残っています。');
          if(trial.autoKeys.has(key)){
            if(!stores[id].targets||!stores[id].targets[member.id])errors.push('対象外店舗への自動配置があります。');
            if(prefOf(input,member.id,day.d)==='×')errors.push('希望×への自動配置があります。');
            if(!stores[id].times[member.id+'-'+day.d])errors.push('自動配置の開始時刻がありません。');
          }
          if(trial.filledTimeKeys&&trial.filledTimeKeys.has(key)&&!stores[id].times[member.id+'-'+day.d])errors.push('補完対象勤務の開始時刻がありません。');
        });
      });
    });
    scope.forEach(function(id){
      input.days.forEach(function(day){input.members.forEach(function(member){
        var key=member.id+'-'+day.d,was=isIn(input.stores,id,day.d,member.id),now=isIn(stores,id,day.d,member.id);
        if(confirmed(input.stores[id],day.d,member.id)&&was){
          if(!now||input.stores[id].times[key]!==stores[id].times[key]||input.stores[id].timeSlots[key]!==stores[id].timeSlots[key])errors.push('確定済み勤務または時刻が変更されています。');
        }
        if(mode==='remaining'&&was){
          if(!now)errors.push('保持対象の勤務が変更されています。');
          if(input.stores[id].times[key]&&input.stores[id].times[key]!==stores[id].times[key])errors.push('保持対象の勤務時刻が変更されています。');
          if(input.stores[id].timeSlots[key]&&input.stores[id].timeSlots[key]!==stores[id].timeSlots[key])errors.push('保持対象の募集枠が変更されています。');
        }
      });});
    });
    Object.keys(input.specialPrefs||{}).forEach(function(mid){Object.keys(input.specialPrefs[mid]||{}).forEach(function(rawDay){
      var d=parseInt(rawDay),requested=input.specialPrefs[mid][rawDay],actual=specialActualStore(input,mid,d),key=mid+'-'+d;
      if(actual&&scopeSet.has(actual)){
        if(!isIn(stores,actual,d,mid))errors.push('実採用済みの特別勤務が変更されています。');
        if(input.stores[actual].times[key]&&input.stores[actual].times[key]!==stores[actual].times[key])errors.push('実採用済みの特別勤務時刻が変更されています。');
        if(input.stores[actual].timeSlots[key]&&input.stores[actual].timeSlots[key]!==stores[actual].timeSlots[key])errors.push('実採用済みの特別勤務枠が変更されています。');
      }else if(!actual&&mode==='unconfirmed'&&scopeSet.has(requested)){
        if(isClosed(stores[requested],d)){
          if(worksOn(stores,d,mid))errors.push('店休日の特別勤務希望が別店舗へ自動移動しています。');
        }else if(!isIn(stores,requested,d,mid))errors.push('営業日の特別勤務希望が採用されていません。');
      }
    });});
    input.members.forEach(function(member){
      var beforeCount=countDays(base,input.days,member.id),afterCount=countDays(stores,input.days,member.id);
      if(member.maxDays>0&&afterCount>member.maxDays&&afterCount>beforeCount)errors.push('最大勤務日数を超える自動配置があります。');
      var beforeRun=maxRun(base,input.days,member.id),afterRun=maxRun(stores,input.days,member.id);
      if(member.noConsec>0&&afterRun>=member.noConsec&&afterRun>beforeRun)errors.push('連勤制限を超える自動配置があります。');
    });
    return Array.from(new Set(errors));
  }

  function bestGroup(input,scope,mode,allowTriangle,attempts,random){
    var bestScore=null,candidates=[],seen=new Set();
    for(var i=0;i<attempts;i++){
      var trial=buildTrial(input,scope,mode,allowTriangle,random),score=scoreResult(input,trial.stores,scope),sig=signature(trial.stores,scope);
      var cmp=bestScore===null?-1:lexCompare(score,bestScore);
      if(cmp<0){bestScore=score;candidates=[Object.assign(trial,{score:score,signature:sig})];seen=new Set([sig]);}
      else if(cmp===0&&!seen.has(sig)&&candidates.length<30){candidates.push(Object.assign(trial,{score:score,signature:sig}));seen.add(sig);}
    }
    // 最良候補の一部へ日付間の移動・交換を試し、改善後の最良群を作り直す。
    var improved=candidates.slice(0,Math.min(3,candidates.length)).map(function(candidate){
      var next=localImprove(input,candidate,scope,allowTriangle,random);
      next.score=scoreResult(input,next.stores,scope);next.signature=signature(next.stores,scope);return next;
    });
    var pool=candidates.concat(improved),finalScore=null,finalCandidates=[],finalSeen=new Set();
    pool.forEach(function(candidate){
      var cmp=finalScore===null?-1:lexCompare(candidate.score,finalScore);
      if(cmp<0){finalScore=candidate.score;finalCandidates=[candidate];finalSeen=new Set([candidate.signature]);}
      else if(cmp===0&&!finalSeen.has(candidate.signature)&&finalCandidates.length<30){finalCandidates.push(candidate);finalSeen.add(candidate.signature);}
    });
    return {score:finalScore,candidates:finalCandidates};
  }

  function solve(input,options){
    options=options||{};
    var scope=(options.scope&&options.scope.length?options.scope:STORE_IDS).filter(function(id){return STORE_IDS.indexOf(id)>=0;});
    var mode=options.mode==='unconfirmed'?'unconfirmed':'remaining',attempts=Math.max(10,parseInt(options.attempts)||120),random=options.random||Math.random;
    for(var si=0;si<scope.length;si++){
      var sid=scope[si];
      for(var di=0;di<input.days.length;di++){
        var day=input.days[di];
        if(isClosed(input.stores[sid],day.d)&&input.members.some(function(member){return isIn(input.stores,sid,day.d,member.id);})){
          return {ok:false,error:'店休日に勤務が残っています。先に店休日の矛盾を修正してください。'};
        }
        for(var mi=0;mi<input.members.length;mi++){
          var member=input.members[mi],timeKey=member.id+'-'+day.d;
          if(isIn(input.stores,sid,day.d,member.id)&&confirmed(input.stores[sid],day.d,member.id)&&!(input.stores[sid].times&&input.stores[sid].times[timeKey])){
            return {ok:false,error:'確定済み勤務の開始時刻がありません。確定を解除して時刻を設定してください。'};
          }
        }
      }
    }
    var circle=bestGroup(input,scope,mode,false,attempts,random),chosen=circle;
    // ○だけで人数・開始時刻とも充足した場合、△探索では上位評価を改善できないため省略する。
    // 不足または遅延が残る場合だけ混合案を作り、実際に上位2評価が改善するときだけ採用する。
    if(!circle.score||circle.score[0]>0||circle.score[1]>0){
      var mixed=bestGroup(input,scope,mode,true,attempts,random);
      if(mixed.score&&circle.score&&lexCompare(mixed.score.slice(0,2),circle.score.slice(0,2))<0)chosen=mixed;
    }
    if(!chosen.candidates.length)return {ok:false,error:'条件を満たすシフト候補を作成できませんでした。'};
    var pool=chosen.candidates,avoid=String(options.avoidSignature||''),different=pool.filter(function(x){return x.signature!==avoid;});
    var selected=(different.length?different:pool)[Math.floor(random()*(different.length?different.length:pool.length))];
    var errors=validate(input,selected,scope,mode);
    if(errors.length)return {ok:false,error:'作成結果の検査に失敗しました：'+errors[0],errors:errors};
    return {
      ok:true,stores:selected.stores,score:selected.score,signature:selected.signature,
      alternative:pool.length>1&&different.length>0,usedTriangle:selected.score[2],warnings:selected.warnings||[],scope:scope,mode:mode
    };
  }

  return {solve:solve,scoreResult:scoreResult,signature:signature,validate:validate,timeToMinutes:timeToMinutes,minutesToTime:minutesToTime,slotsFor:slotsFor,lexCompare:lexCompare};
});
