// Stress-test prototype (Step 1). Usage: node docs/stress-test/sim.js . any|share [deseas] roll|moq
// Not production code: lib/engine replaces this in Milestone 2 (TEST_PLAN RN-12).
// Forward simulation of the locked rules (BUILD_PLAN §8 + C-004/C-005) on the case data.
// Assumptions (stress-test only): lead time 2 wks (D18), every recommendation approved and issued
// the same week, arrives at the start of week+lead. True demand: pre-festival base (W27-W38 mean),
// times the observed W39-W42 lift on any week touching the festival/pre-load period, base otherwise.
const fs=require('fs'),path=require('path');
const root=process.argv[2];
const rd=f=>{const [h,...r]=fs.readFileSync(path.join(root,f),'utf8').trim().split(/\r?\n/);const k=h.split(',');return r.map(l=>Object.fromEntries(l.split(',').map((v,i)=>[k[i],v])))};
const MODE=process.argv[3]||'any'; // 'any' = C-004 as approved; 'share' = proportional
const POLICY=process.argv[5]||'roll';const DESEAS=process.argv[4]==='deseas';
// ISO week helpers
const mondayOf=(y,w)=>{const j4=new Date(Date.UTC(y,0,4));const d=(j4.getUTCDay()+6)%7;const m=new Date(j4);m.setUTCDate(4-d+(w-1)*7);return m;};
const weeksIn=y=>{const d=new Date(Date.UTC(y,11,28));return isoOf(d).w;};
function isoOf(d){const t=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));const day=(t.getUTCDay()+6)%7;t.setUTCDate(t.getUTCDate()-day+3);const y=t.getUTCFullYear();const f=new Date(Date.UTC(y,0,4));return {y,w:1+Math.round(((t-f)/864e5-3+((f.getUTCDay()+6)%7))/7)};}
const add=([y,w],n)=>{w+=n;while(w>weeksIn(y)){w-=weeksIn(y);y++;}return [y,w];};
const lab=([y,w])=>`${y}-W${String(w).padStart(2,'0')}`;
// festival events from case month flags, + 3-week pre-load
const cal=rd('data/case/calendar.csv').filter(r=>r.Is_Festival_Month==='TRUE').map(r=>{const s=new Date(Date.UTC(+r.Year,+r.Month-1,1));const e=new Date(Date.UTC(+r.Year,+r.Month,0));const p=new Date(s);p.setUTCDate(p.getUTCDate()-21);return {s,e,p};});
cal.push(...[3].map(m=>{const s=new Date(Date.UTC(2027,m-1,1)),e=new Date(Date.UTC(2027,m,0)),p=new Date(s);p.setUTCDate(p.getUTCDate()-21);return {s,e,p};}));
const touches=(wk,pre)=>{const m=mondayOf(...wk),su=new Date(m);su.setUTCDate(su.getUTCDate()+6);return cal.some(c=>m<=c.e&&su>=(pre?c.p:c.s));};
const sku=Object.fromEntries(rd('data/case/sku_master.csv').map(r=>[r.SKU_ID,r]));
const hist={};rd('data/case/weekly_sales.csv').forEach(r=>(hist[r.SKU_ID]??=[]).push({wk:r.Week,u:+r.Units_Sold,fest:touches([+r.Week.slice(0,4),+r.Week.slice(6)],true)}));
const onhand=Object.fromEntries(rd('data/case/current_inventory.csv').map(r=>[r.SKU_ID,+r.Units_On_Hand]));
const lots={};for(const k in onhand)lots[k]=[{q:onhand[k],age:0}];const wo={};const pipe={};for(const s in sku)pipe[s]=[];
const base={},lift={};for(const s in hist){const v=hist[s].map(x=>x.u);base[s]=v.slice(0,12).reduce((a,b)=>a+b)/12;lift[s]=v.slice(12).reduce((a,b)=>a+b)/4/base[s];}
const L=2,U=1.25;let wk=[2026,43];const out=[];
const stats={};for(const s in sku)stats[s]={stockoutWks:0,lost:0,queue:0,auto:0,orders:0,unitsOrdered:0,actions:[]};
for(let t=0;t<12;t++){
  const lw=lab(wk);
  for(const s in sku){
    const per=sku[s].Perishability==='High',std=+sku[s].Standard_Reorder_Qty;
    const clean=hist[s].filter(x=>!x.zero);
    const val=x=>DESEAS&&x.fest?x.u/U:x.u;
    const a12=clean.slice(-12).reduce((a,x)=>a+val(x),0)/Math.min(12,clean.length);
    const r12=clean.slice(-12).reduce((a,x)=>a+x.u,0)/Math.min(12,clean.length);
    const a4=clean.slice(-4).reduce((a,x)=>a+x.u,0)/4;
    const [mn,mx]=per?[Math.max(3,L+2),4]:[Math.max(6,L+2),14];
    const win=[...Array(mn).keys()].map(i=>add(wk,L+i));
    const share=win.filter(w=>touches(w,true)).length/win.length;
    const fac=MODE==='any'?(share>0?U:1):1+(U-1)*share;
    const F=a12*fac;
    const P=onhand[s]+pipe[s].reduce((a,o)=>a+o.q,0);
    const C=P/F,hd=a4>1.2*r12;
    let act='none',q=0;
    if(C>mx)act='pause';else if(C<mn||hd){act='reorder';q=std*(hd?1.5:1);while(P+q<mn*F)q+=std;q=Math.max(q,std);var inf=false;if(per){const cap=Math.floor(mx*F-P);if(cap<std){inf=true;q=POLICY==='moq'?std:0;}else q=Math.min(q,cap);}}
    const border=[mn,mx].some(b=>Math.abs(C-b)<=0.05*b);
    const auto=act==='reorder'&&!per&&!hd&&!border&&q<=2*std;
    const st=stats[s];st.actions.push(act==='reorder'?(typeof inf!=='undefined'&&inf?'I':(auto?'A':'Q'))+q:act==='pause'?'P':'.');if(typeof inf!=='undefined'&&inf)st.inf=(st.inf||0)+1;inf=false;
    if(act==='reorder'&&q>0){st.orders++;st.unitsOrdered+=q;auto?st.auto++:st.queue++;pipe[s].push({q,arr:add(wk,L)});}
    else if(per||border||(act==='pause'))st.queue+=0;
  }
  // simulate the week: arrivals at start, then demand
  for(const s in sku){
    pipe[s]=pipe[s].filter(o=>{if(lab(o.arr)===lw){onhand[s]+=o.q;lots[s].push({q:o.q,age:0});return false;}return true;});
    const dem=Math.round(base[s]*(touches(wk,true)?lift[s]:1));
    const sold=Math.min(dem,onhand[s]);onhand[s]-=sold;{let r=sold;for(const l of lots[s]){const t=Math.min(l.q,r);l.q-=t;r-=t;}lots[s]=lots[s].filter(l=>l.q>0);lots[s].forEach(l=>l.age++);if(sku[s].Perishability==='High'){const old=lots[s].filter(l=>l.age>=8).reduce((a,l)=>a+l.q,0);wo[s]=(wo[s]||0)+old;onhand[s]-=old;lots[s]=lots[s].filter(l=>l.age<8);}}
    if(onhand[s]===0){stats[s].stockoutWks++;}
    stats[s].lost+=dem-sold;
    hist[s].push({wk:lw,u:sold,fest:touches(wk,true),zero:onhand[s]===0&&sold<dem});
    stats[s].endOnHand=onhand[s];stats[s].endCoverDec=onhand[s]/base[s];
  }
  wk=add(wk,1);
}
console.log(`MODE=${MODE} DESEAS=${DESEAS}  weeks 2026-W43..${lab(add(wk,-1))}`);
console.log('SKU    per  lift  actions(A=auto,Q=queue,P=pause)                          orders  units  stockoutWks lost  endOH endCover(base wks)');
for(const s in sku){const st=stats[s];console.log(s,sku[s].Perishability==='High'?'H':'L',lift[s].toFixed(2).padStart(5),st.actions.join(' ').padEnd(60),String(st.orders).padStart(3),String(st.unitsOrdered).padStart(6),String(st.stockoutWks).padStart(6),String(st.lost).padStart(6),String(st.endOnHand).padStart(6),st.endCoverDec.toFixed(1).padStart(6));}
const tot=k=>Object.values(stats).reduce((a,s)=>a+s[k],0);
console.log('perishable write-off units (8-wk shelf assumed):',JSON.stringify(wo),' infeasible weeks:',JSON.stringify(Object.fromEntries(Object.entries(stats).filter(([k,v])=>v.inf).map(([k,v])=>[k,v.inf]))));console.log('TOTAL queue cards',tot('queue'),'auto',tot('auto'),'stockoutWks',tot('stockoutWks'),'lost units',tot('lost'));
// Window check around festival end
for(const w of [[2026,45],[2026,46],[2026,47],[2026,48],[2026,49]]){const win=[...Array(6).keys()].map(i=>add(w,2+i));console.log(lab(w),'non-perishable window',lab(win[0]),'..',lab(win[5]),'festival weeks',win.filter(x=>touches(x,true)).length,'/6');}
