// W9's export/import round trip, probed past its criteria, across two containers.
// Requires BASE_URL and ALT_BASE_URL pointing at two independently started services.
//
//   BASE_URL=http://127.0.0.1:A ALT_BASE_URL=http://127.0.0.1:B node .../w9-roundtrip-probe.mjs
//
// The atomicity section takes a fresh baseline per case (D66). Its first version used one
// baseline for a mutating loop and manufactured a partial-apply finding that did not exist --
// which would have been a false blocking verdict had it not been isolated before reporting.
const A=process.env.BASE_URL, Bb=process.env.ALT_BASE_URL;
let pass=0,fail=0; const F=[];
const ok=(id,n,c,d='')=>{c?(pass++,console.log(`  PASS [${id}] ${n}`)):(fail++,F.push(`[${id}] ${n} :: ${d}`),console.log(`  FAIL [${id}] ${n} :: ${d}`));};
const rq=async(base,m,p,{body,headers={},raw}={})=>{const h={...headers};let b;
 if(raw!==undefined){b=raw;h['Content-Type']??='application/json';}else if(body!==undefined){b=JSON.stringify(body);h['Content-Type']='application/json';}
 const r=await fetch(base+p,{method:m,headers:h,body:b});const t=await r.text();let j=null;try{j=JSON.parse(t);}catch{};return{status:r.status,text:t,json:j};};
const HS=['ada','bob','cy'];
const FX={currency:'EUR',minor_units:2,users:HS.map((h,i)=>({id:`u_${h}`,email:`${h}@example.com`,password:'correct horse',display_name:h.toUpperCase(),handle:h,balance:10000})),payments:[],requests:[],settlement_operator_ids:['u_ada']};
let n=0; const K=()=>`w9-${++n}-${Date.now()}`;
const AU=(t)=>({Authorization:`Bearer ${t}`});
const exp=(base)=>rq(base,'GET','/_test/export');
const imp=(base,body)=>rq(base,'POST','/_test/import',{body});
const st=async(base)=>(await exp(base)).json.state;

console.log('\n== build a rich state on A ==');
let T={}, artifacts={};
{ await rq(A,'POST','/_test/reset',{body:FX});
  for(const h of HS) T[h]=(await rq(A,'POST','/auth/login',{body:{email:`${h}@example.com`,password:'correct horse'}})).json.token;
  T.ada2=(await rq(A,'POST','/auth/login',{body:{email:'ada@example.com',password:'correct horse'}})).json.token;
  const sg=await rq(A,'POST','/auth/signup',{body:{email:'joiner@example.com',password:'a joiner passphrase',display_name:'Joiner'}});
  T.joiner=sg.json.token; artifacts.joinerId=sg.json.user_id;
  artifacts.payKey=K();
  artifacts.payment=await rq(A,'POST','/payments',{body:{to_handle:'bob',amount:321,note:'kept \u{1F44D}',visibility:'private'},headers:{...AU(T.ada),'Idempotency-Key':artifacts.payKey}});
  artifacts.reqKey=K();
  artifacts.request=await rq(A,'POST','/requests',{body:{payer_handle:'bob',amount:654,note:'owed'},headers:{...AU(T.ada),'Idempotency-Key':artifacts.reqKey}});
  const payable=await rq(A,'POST','/requests',{body:{payer_handle:'bob',amount:111},headers:{...AU(T.ada),'Idempotency-Key':K()}});
  await rq(A,'POST',`/requests/${payable.json.request_id}/pay`,{body:{},headers:{...AU(T.bob),'Idempotency-Key':K()}});
  const dec=await rq(A,'POST','/requests',{body:{payer_handle:'bob',amount:222},headers:{...AU(T.ada),'Idempotency-Key':K()}});
  await rq(A,'POST',`/requests/${dec.json.request_id}/decline`,{headers:AU(T.bob)});
  artifacts.splitKey=K();
  artifacts.split=await rq(A,'POST','/splits',{body:{amount:1000,participant_handles:['ada','bob','joiner'],note:'shared'},headers:{...AU(T.ada),'Idempotency-Key':artifacts.splitKey}});
  artifacts.failedKey=K();
  artifacts.failed=await rq(A,'POST','/payments',{body:{to_handle:'bob',amount:0},headers:{...AU(T.ada),'Idempotency-Key':artifacts.failedKey}});
  ok('setup','a rich state built on A (payments, requests in three states, a split, claimed and freed keys)',
     artifacts.payment.status===201&&artifacts.request.status===201&&artifacts.split.status===201&&artifacts.failed.status===422,
     `${artifacts.payment.status}/${artifacts.request.status}/${artifacts.split.status}/${artifacts.failed.status}`); }

console.log('\n== criteria 1, 12: the export/import envelope, unauthenticated ==');
{ const e=await exp(A);
  ok(1,'export -> 200 {track:"pocketful", format_version:1, state:object}',
     e.status===200&&e.json.track==='pocketful'&&e.json.format_version===1&&e.json.state&&typeof e.json.state==='object', `${e.status}`);
  const noTok=await rq(Bb,'POST','/_test/import',{body:e.json});
  ok(12,'neither endpoint needs a token: import with no Authorization -> 204', noTok.status===204, `${noTok.status} ${noTok.text.slice(0,120)}`);
  const g=await rq(A,'GET','/_test/export',{headers:{Authorization:'Bearer garbage'}});
  ok('12b','export with a garbage Authorization header -> 200', g.status===200, `${g.status}`); }

console.log('\n== criterion 7, 16: import wipes B, including B\'s own credentials ==');
{ await rq(Bb,'POST','/_test/reset',{body:{currency:'JPY',minor_units:0,users:[{id:'u_ghost',email:'ghost@example.com',password:'correct horse',display_name:'Ghost',handle:'ghost',balance:5}],payments:[],requests:[]}});
  const bTok=(await rq(Bb,'POST','/auth/login',{body:{email:'ghost@example.com',password:'correct horse'}})).json.token;
  const meBefore=await rq(Bb,'GET','/me',{headers:AU(bTok)});
  const e=await exp(A);
  const i=await imp(Bb,e.json);
  ok(7,'import into B -> 204', i.status===204, `${i.status} ${i.text.slice(0,140)}`);
  const ghostLogin=await rq(Bb,'POST','/auth/login',{body:{email:'ghost@example.com',password:'correct horse'}});
  ok('7b',"B's pre-import user can no longer log in", ghostLogin.status===401, `${ghostLogin.status}`);
  const bTokAfter=await rq(Bb,'GET','/me',{headers:AU(bTok)});
  ok(16,"R10.15: a token B issued BEFORE the import no longer authenticates after it",
     meBefore.status===200&&bTokAfter.status===401&&bTokAfter.json?.error?.code==='unauthenticated', `before ${meBefore.status} after ${bTokAfter.status}`); }

console.log('\n== criterion 2: the two-container round trip ==');
{ const me=await rq(Bb,'GET','/me',{headers:AU(T.ada)});
  ok(2,"a token issued by A authenticates against B and returns A's account",
     me.status===200&&me.json.user_id==='u_ada'&&me.json.handle==='ada', `${me.status} ${me.text.slice(0,160)}`);
  const lg=await rq(Bb,'POST','/auth/login',{body:{email:'cy@example.com',password:'correct horse'}});
  ok('2b','a seeded password logs in on B (hashes restored, never re-hashed)', lg.status===200&&!!lg.json.token, `${lg.status}`);
  const sA=await st(A), sB=await st(Bb);
  ok('2c','balances match exactly', JSON.stringify(sA.users.map(u=>[u.id,u.balance]).sort())===JSON.stringify(sB.users.map(u=>[u.id,u.balance]).sort()),
     `A ${JSON.stringify(sA.users.map(u=>u.balance))} B ${JSON.stringify(sB.users.map(u=>u.balance))}`);
  ok('2d','payments, requests and splits match in count and id',
     JSON.stringify(sA.payments.map(p=>p.id).sort())===JSON.stringify(sB.payments.map(p=>p.id).sort()) &&
     JSON.stringify(sA.requests.map(r=>r.id).sort())===JSON.stringify(sB.requests.map(r=>r.id).sort()) &&
     JSON.stringify(sA.splits.map(s=>s.id).sort())===JSON.stringify(sB.splits.map(s=>s.id).sort()),
     `A p${sA.payments.length}/r${sA.requests.length}/s${sA.splits.length} B p${sB.payments.length}/r${sB.requests.length}/s${sB.splits.length}`);
  const feedA=await rq(A,'GET','/activity?limit=200',{headers:AU(T.ada)});
  const feedB=await rq(Bb,'GET','/activity?limit=200',{headers:AU(T.ada)});
  ok('2e',"A's feed and B's feed are identical for the same token", feedA.text===feedB.text, 'the feeds differ');
  const reqA=await rq(A,'GET','/requests?limit=200',{headers:AU(T.ada)});
  const reqB=await rq(Bb,'GET','/requests?limit=200',{headers:AU(T.ada)});
  ok('2f','GET /requests is identical on both', reqA.text===reqB.text, 'the request lists differ'); }

console.log('\n== criterion 15: R10.12, nothing regenerated ==');
{ const sA=await st(A), sB=await st(Bb);
  const ids=(s)=>[...s.users.map(u=>u.id),...s.payments.map(p=>p.id),...s.requests.map(r=>r.id),...s.splits.map(x=>x.id)].sort();
  ok(15,'every user, payment, request and split id is identical on B', JSON.stringify(ids(sA))===JSON.stringify(ids(sB)), 'ids differ');
  const ts=(s)=>[...s.payments.map(p=>p.created_at),...s.requests.map(r=>r.created_at),...s.splits.map(x=>x.created_at)].sort();
  ok('15b','every created_at is identical on B (no regeneration)', JSON.stringify(ts(sA))===JSON.stringify(ts(sB)), `A ${JSON.stringify(ts(sA).slice(0,2))} B ${JSON.stringify(ts(sB).slice(0,2))}`);
  ok('15c','sequence_counter and seeded_total carried over', sA.sequence_counter===sB.sequence_counter&&sA.seeded_total===sB.seeded_total,
     `seq ${sA.sequence_counter}/${sB.sequence_counter} total ${sA.seeded_total}/${sB.seeded_total}`);
  const sumA=sA.users.reduce((a,u)=>a+u.balance,0), sumB=sB.users.reduce((a,u)=>a+u.balance,0);
  ok('15d','seeded payments were NOT replayed against imported balances (R1.7 holds on B)', sumA===sumB&&sumB===sB.seeded_total, `${sumA} vs ${sumB} vs seeded ${sB.seeded_total}`);
  ok('15e','password hashes are byte-identical on B (never re-hashed)',
     JSON.stringify(sA.users.map(u=>[u.id,u.password_hash]).sort())===JSON.stringify(sB.users.map(u=>[u.id,u.password_hash]).sort()), 'hashes differ'); }

console.log('\n== criteria 3, 4: idempotency records survive ==');
{ const bal=async(base,h)=>(await st(base)).users.find(u=>u.handle===h).balance;
  const b0=await bal(Bb,'bob');
  const replay=await rq(Bb,'POST','/payments',{body:{to_handle:'bob',amount:321,note:'kept \u{1F44D}',visibility:'private'},headers:{...AU(T.ada),'Idempotency-Key':artifacts.payKey}});
  ok(3,'a completed idempotent request replayed on B -> 200 with the ORIGINAL response body',
     replay.status===200&&JSON.stringify(replay.json)===JSON.stringify(artifacts.payment.json), `${replay.status} identical=${JSON.stringify(replay.json)===JSON.stringify(artifacts.payment.json)}`);
  ok('3b','and moved no money on B', (await bal(Bb,'bob'))===b0, `${b0} -> ${await bal(Bb,'bob')}`);
  const rr=await rq(Bb,'POST','/requests',{body:{payer_handle:'bob',amount:654,note:'owed'},headers:{...AU(T.ada),'Idempotency-Key':artifacts.reqKey}});
  ok('3c','a replayed request returns its original body too', rr.status===200&&JSON.stringify(rr.json)===JSON.stringify(artifacts.request.json), `${rr.status}`);
  const sp=await rq(Bb,'POST','/splits',{body:{amount:1000,participant_handles:['ada','bob','joiner'],note:'shared'},headers:{...AU(T.ada),'Idempotency-Key':artifacts.splitKey}});
  ok('3d','a replayed split returns its original body', sp.status===200&&JSON.stringify(sp.json)===JSON.stringify(artifacts.split.json), `${sp.status}`);
  const freed=await rq(Bb,'POST','/payments',{body:{to_handle:'bob',amount:7},headers:{...AU(T.ada),'Idempotency-Key':artifacts.failedKey}});
  ok(4,'a key that failed with 4xx before the export is still reusable on B -> 201', freed.status===201, `${freed.status} ${freed.text.slice(0,140)}`); }

console.log('\n== criterion 14: D60, request_ids resolve after import ==');
{ const sB=await st(Bb);
  const sp=sB.splits[0];
  const resolved=sp.request_ids.map(id=>sB.requests.find(r=>r.id===id));
  ok(14,'every request_id in an imported split resolves to a real request on B', resolved.every(Boolean), JSON.stringify(sp.request_ids));
  const sA=await st(A);
  const aStatus=sp.request_ids.map(id=>sA.requests.find(r=>r.id===id)?.status);
  const bStatus=resolved.map(r=>r.status);
  ok('14b','and each carries the live status it had on A, not a frozen copy', JSON.stringify(aStatus)===JSON.stringify(bStatus), `A ${JSON.stringify(aStatus)} B ${JSON.stringify(bStatus)}`); }

console.log('\n== criteria 6, 8, 9, 11: repeat, reject, reset ==');
{ const e=await exp(A);
  const before=await st(Bb);
  await imp(Bb,e.json); const once=await st(Bb);
  await imp(Bb,e.json); const twice=await st(Bb);
  ok(6,'importing the same export twice leaves identical state, nothing duplicated', JSON.stringify(once)===JSON.stringify(twice),
     `users ${once.users.length}/${twice.users.length} payments ${once.payments.length}/${twice.payments.length}`);
  const bad=[['missing track',{format_version:1,state:e.json.state}],['track "other"',{track:'other',format_version:1,state:e.json.state}],
             ['format_version 2',{track:'pocketful',format_version:2,state:e.json.state}],['state a string',{track:'pocketful',format_version:1,state:'nope'}],
             ['state null',{track:'pocketful',format_version:1,state:null}],['state an array',{track:'pocketful',format_version:1,state:[]}],
             ['state absent',{track:'pocketful',format_version:1}]];
  const errs=[];
  for(const [l,body] of bad){ const r=await imp(Bb,body);
    if(!(r.status===422&&r.json?.error?.code==='validation_failed')) errs.push(`${l} -> ${r.status}/${r.json?.error?.code}`); }
  const after=await st(Bb);
  ok(8,'seven malformed envelopes all -> 422 validation_failed', errs.length===0, errs.join(' | '));
  ok('8b',"and B's state is unchanged, read back", JSON.stringify(twice)===JSON.stringify(after), 'B changed after a rejected import');
  const unp=await rq(Bb,'POST','/_test/import',{raw:'{not json'});
  ok(9,'an unparseable body -> 400 malformed_request', unp.status===400&&unp.json?.error?.code==='malformed_request', `${unp.status}/${unp.json?.error?.code}`);
  const rst=await rq(Bb,'POST','/_test/reset',{body:{currency:'EUR',minor_units:2,users:[{id:'u_only',email:'only@example.com',password:'correct horse',display_name:'O',handle:'only',benign:1,balance:1}],payments:[],requests:[]}});
  const cleared=await st(Bb);
  ok(11,'POST /_test/reset after an import clears the imported state', rst.status===204&&cleared.users.length===1&&cleared.users[0].id==='u_only'&&cleared.payments.length===0,
     `${rst.status} users ${cleared.users.length} payments ${cleared.payments.length}`); }

console.log('\n== criterion 10: export is a snapshot ==');
{ const e1=await exp(A);
  await rq(A,'POST','/payments',{body:{to_handle:'cy',amount:5},headers:{...AU(T.ada),'Idempotency-Key':K()}});
  const e2=await exp(A);
  ok(10,'a write after the export does not change what the earlier export holds', e1.text!==e2.text && e1.json.state.payments.length<e2.json.state.payments.length,
     `before ${e1.json.state.payments.length} after ${e2.json.state.payments.length}`);
  await rq(Bb,'POST','/_test/import',{body:e1.json});
  const sB=await st(Bb);
  ok('10b','importing the EARLIER export restores the earlier state, not the later one', sB.payments.length===e1.json.state.payments.length,
     `${sB.payments.length} vs ${e1.json.state.payments.length}`); }

console.log('\n== beyond the criteria: does import stay atomic? (D66: a baseline per case) ==');
{ // D66. This loop first ran with ONE baseline captured before it, so cases whose earlier
  // neighbours were legitimately accepted compared against stale state and reported a
  // partial apply that did not exist. A probe that mutates state in a loop must re-establish
  // the baseline per case; the cost is one reset.
  const FX0={currency:'EUR',minor_units:2,users:[
    {id:'u_x',email:'x@example.com',password:'correct horse',display_name:'X',handle:'xxx',balance:700},
    {id:'u_y',email:'y@example.com',password:'correct horse',display_name:'Y',handle:'yyy',balance:300}],payments:[],requests:[]};
  const cases=[
   ['users not an array',      (g)=>({...g,state:{...g.state,users:'no'}})],
   ['a user missing id',       (g)=>({...g,state:{...g.state,users:[{email:'x@y.z',handle:'x',balance:0}]}})],
   ['sequence_counter a string',(g)=>({...g,state:{...g.state,sequence_counter:'x'}})],
   ['a payment naming an unknown user',(g)=>({...g,state:{...g.state,payments:[{id:'p_x',from_user_id:'u_ghost',to_user_id:'u_x',amount:1,note:'',visibility:'public',request_id:null,settlement_id:null,created_at:'2026-01-01T00:00:00+00:00',sequence:1}]}})],
   ['a negative balance',      (g)=>({...g,state:{...g.state,users:g.state.users.map((u,i)=>i===0?{...u,balance:-5}:u)}})],
   ['a split naming a missing request',(g)=>({...g,state:{...g.state,splits:[{id:'sp_x',caller_id:'u_x',amount:1,note:'',shares:[],request_ids:['rq_ghost'],created_at:'2026-01-01T00:00:00+00:00',sequence:1}]}})],
  ];
  const partial=[], fivexx=[], accepted=[];
  for(const [label,mutate] of cases){
    await rq(A,'POST','/_test/reset',{body:FX0});
    const good=(await exp(A)).json;
    await rq(Bb,'POST','/_test/reset',{body:FX0});
    const base=await st(Bb);                       // fresh, per case
    const r=await imp(Bb,mutate(good));
    const after=await st(Bb);
    const unchanged=JSON.stringify(base)===JSON.stringify(after);
    if(r.status>=500) fivexx.push(label);
    else if(r.status===204) accepted.push(label);
    else if(!unchanged) partial.push(`${label} -> ${r.status} but the destination CHANGED`);
  }
  ok('p1','no 5xx on any structurally invalid state', fivexx.length===0, fivexx.join(' | '));
  ok('p2','every REJECTED state left the destination byte-identical (R10.8, no partial apply)', partial.length===0, partial.join(' | '));
  console.log(`     accepted at 204 (not rejected by design today): ${accepted.length ? accepted.join(', ') : 'none'}`);
  const h=await rq(Bb,'GET','/health'); ok('p3','B is still healthy afterwards', h.status===200, `${h.status}`); }
console.log(`\n==== W9 PROBE: ${pass} pass, ${fail} fail ====`);
if(F.length){console.log('FINDINGS:');F.forEach((f,i)=>console.log(` ${i+1}. ${f}`));}
