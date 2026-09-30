// The coordinator's W2, W2b and W3 acceptance criteria, executable.
// Covers what the HTTP suite cannot reach on its own: the C3 derivation order,
// D21, D34-D36, the D26b measurement and the settlement_operator_ids relocation.
//
//   BASE_URL=http://127.0.0.1:PORT node stage-1/acceptance/probes/w2-w2b-w3-criteria.mjs
//
// Committed rather than left in /tmp: this was the evidence behind four verdicts,
// and D28's reasoning applies to the verifier's scripts as much as the implementer's.
const BASE = process.env.BASE_URL;
let pass=0,fail=0; const F=[];
const ok=(id,n,c,d='')=>{ if(c){pass++;console.log(`  PASS [${id}] ${n}`);}else{fail++;F.push(`[${id}] ${n} :: ${d}`);console.log(`  FAIL [${id}] ${n} :: ${d}`);} };
async function req(m,p,{body,headers={},raw}={}){const h={...headers};let b;
 if(raw!==undefined){b=raw;h['Content-Type']??='application/json';} else if(body!==undefined){b=JSON.stringify(body);h['Content-Type']='application/json';}
 const r=await fetch(BASE+p,{method:m,headers:h,body:b});const t=await r.text();let j=null;try{j=JSON.parse(t);}catch{};
 return{status:r.status,text:t,json:j,ct:r.headers.get('content-type'),cl:r.headers.get('content-length')};}
const fx=(o={})=>({currency:'EUR',minor_units:2,users:[],payments:[],requests:[],...o});
const U=(i,o={})=>({id:`u_${i}`,email:`u${i}@example.com`,password:'correct horse',display_name:`U${i}`,handle:`u${i}`,balance:0,...o});
const A=fx({users:[U(1,{balance:10000,handle:'ada',email:'ada@example.com',display_name:'Ada'}),U(2,{balance:2500,handle:'bob',email:'bob@example.com'})]});
const B=fx({currency:'JPY',minor_units:0,users:[U(9,{balance:400,handle:'zed',email:'zed@example.com'})]});
const st=async()=>(await req('GET','/_test/export')).json.state;

console.log('\n########## W2 — reset and fixture ##########');
{ const r=await req('POST','/_test/reset',{body:A});
  const h=await req('GET','/health');
  ok('W2.1','valid EUR fixture -> 204 with an empty body; /health then 200', r.status===204&&r.text===''&&h.status===200, `${r.status} body=${JSON.stringify(r.text)} health=${h.status}`); }
{ await req('POST','/_test/reset',{body:A}); await req('POST','/_test/reset',{body:B});
  let s=await st();
  const onlyB=s.currency==='JPY'&&s.minor_units===0&&s.users.length===1&&s.users[0].handle==='zed';
  const r2=await req('POST','/_test/reset',{body:B}); s=await st();
  ok('W2.2','reset A then B leaves only B; repeating the same fixture is fine', onlyB&&r2.status===204&&s.users.length===1, `onlyB=${onlyB} repeat=${r2.status} users=${s.users.length}`); }
{ await req('POST','/_test/reset',{body:A}); const b4=await st();
  const r=await req('POST','/_test/reset',{body:fx({users:[U(1,{balance:-1})]})}); const af=await st();
  ok('W2.3','negative balance -> 422 validation_failed, previous state read back unchanged',
     r.status===422&&r.json?.error?.code==='validation_failed'&&JSON.stringify(b4)===JSON.stringify(af), `${r.status} ${r.json?.error?.code}; state ${JSON.stringify(b4)===JSON.stringify(af)?'unchanged':'CHANGED'}`); }
{ const res={};
  for(const mu of [0,1,2,3,4]){ const cur=mu===0?'JPY':mu===3?'BHD':'EUR';
    res[mu]=(await req('POST','/_test/reset',{body:fx({currency:cur,minor_units:mu,users:[U(1)]})})).status; }
  ok('W2.4','minor_units 0/2/3 accepted, 1 and 4 -> 422', res[0]===204&&res[2]===204&&res[3]===204&&res[1]===422&&res[4]===422, JSON.stringify(res)); }
{ await req('POST','/_test/reset',{body:A}); const b4=await st(); const bad=[];
  const cases=[
   ['payment names an unknown user_id', fx({users:[U(1),U(2)],payments:[{id:'p_1',from_user_id:'u_404',to_user_id:'u_2',amount:1,visibility:'public'}]})],
   ['request names an unknown user_id', fx({users:[U(1),U(2)],requests:[{id:'rq_1',requester_id:'u_1',payer_id:'u_404',amount:1,status:'pending'}]})],
   ['two users share a handle', fx({users:[U(1),U(2,{handle:'u1'})]})],
   ['two users share an email', fx({users:[U(1),U(2,{email:'u1@example.com'})]})],
   ['two users share an id', fx({users:[U(1),{...U(2),id:'u_1'}]})],
   ['handle fails ^[a-z0-9_]{1,20}$', fx({users:[U(1,{handle:'Bad-Handle!'})]})],
   ['handle longer than 20', fx({users:[U(1,{handle:'a'.repeat(21)})]})],
   ['missing required field (no handle)', fx({users:[(()=>{const u=U(1);delete u.handle;return u;})()]})],
   ['seeded request status not one of the four', fx({users:[U(1),U(2)],requests:[{id:'rq_1',requester_id:'u_1',payer_id:'u_2',amount:1,status:'maybe'}]})],
   ['non-integral balance', fx({users:[U(1,{balance:10.5})]})],
   ['non-integral amount', fx({users:[U(1),U(2)],payments:[{id:'p_1',from_user_id:'u_1',to_user_id:'u_2',amount:1.5,visibility:'public'}]})],
   ['amount 0 (below 1)', fx({users:[U(1),U(2)],payments:[{id:'p_1',from_user_id:'u_1',to_user_id:'u_2',amount:0,visibility:'public'}]})],
   ['amount 1000000001', fx({users:[U(1),U(2)],payments:[{id:'p_1',from_user_id:'u_1',to_user_id:'u_2',amount:1000000001,visibility:'public'}]})],
   ['balance above 2^53', fx({users:[U(1,{balance:9007199254740994})]})],
   ['balance below -2^53', fx({users:[U(1,{balance:-9007199254740994})]})],
  ];
  for(const [label,body] of cases){ const r=await req('POST','/_test/reset',{body});
    if(!(r.status===422&&r.json?.error?.code==='validation_failed')) bad.push(`${label} -> ${r.status} ${r.json?.error?.code}`); }
  const af=await st();
  ok('W2.5',`all 15 invalid fixtures -> 422 validation_failed`, bad.length===0, bad.join(' | '));
  ok('W2.5b','none of the 15 rejected resets changed state', JSON.stringify(b4)===JSON.stringify(af), 'state changed after a rejected reset'); }
{ const u=await req('POST','/_test/reset',{raw:'{not json'});
  const arr=await req('POST','/_test/reset',{raw:'[1,2,3]'});
  const num=await req('POST','/_test/reset',{raw:'42'});
  const str=await req('POST','/_test/reset',{raw:'"hello"'});
  ok('W2.6','unparseable -> 400; parses-but-not-an-object -> 400 (D12)',
     u.status===400&&arr.status===400&&num.status===400&&str.status===400, `unparseable ${u.status}, array ${arr.status}, number ${num.status}, string ${str.status}`); }
{ const none=await req('POST','/_test/reset',{body:A});
  const garb=await req('POST','/_test/reset',{body:A,headers:{Authorization:'Bearer total-garbage'}});
  const basic=await req('POST','/_test/reset',{body:A,headers:{Authorization:'!!! not even a scheme'}});
  ok('W2.8','reset works with no Authorization header and with a garbage one', none.status===204&&garb.status===204&&basic.status===204, `${none.status}/${garb.status}/${basic.status}`); }
{ await req('POST','/_test/reset',{body:A}); const s=await st();
  ok('W2.9','seeded total captured and equal to the sum of seeded balances', s.seeded_total===12500&&s.seeded_total===s.users.reduce((a,u)=>a+u.balance,0), `seeded_total ${s.seeded_total} vs sum ${s.users.reduce((a,u)=>a+u.balance,0)}`); }
{ const t0=Date.now(); const hd=await req('HEAD','/health'); const dt=Date.now()-t0;
  const g=await req('GET','/health'); const e=await req('GET','/_test/export'); const err=await req('GET','/nope');
  ok('C1/W2.10',`HEAD /health returns promptly (${dt}ms, not a timeout) and responses carry Content-Length`,
     hd.status===200&&dt<1000&&!!g.cl&&!!e.cl&&!!err.cl, `HEAD ${hd.status} in ${dt}ms; Content-Length health=${g.cl} export=${e.cl} 404=${err.cl}`); }

console.log('\n########## W2b — store correctness and observability ##########');
{ const users=Array.from({length:500},(_,i)=>U(i+1,{email:`d${i}@example.com`,handle:`d${i}`,password:`distinct-pw-${i}-${'y'.repeat(i%13)}`,balance:1}));
  const ts=[];
  for(let k=0;k<3;k++){ const t0=Date.now(); const r=await req('POST','/_test/reset',{body:fx({users})}); ts.push([Date.now()-t0,r.status]); }
  const lg=await req('POST','/auth/login',{body:{email:'d499@example.com',password:`distinct-pw-499-${'y'.repeat(499%13)}`}});
  ok('W2b.1',`D26b: 500 DISTINCT passwords reset under 3s inside --cpus=2 --memory=2g -- ${ts.map(t=>t[0]+'ms').join(', ')}`,
     ts.every(([d,s])=>s===204&&d<3000)&&lg.status===200, JSON.stringify(ts)+` login ${lg.status}`); }
{ const seed=fx({users:[U(1,{balance:10000,handle:'seed',email:'seed@example.com'}),U(2,{balance:50})],
    payments:[{id:'p_1',from_user_id:'u_1',to_user_id:'u_2',amount:50,visibility:'public'}],
    requests:[{id:'rq_1',requester_id:'u_1',payer_id:'u_2',amount:50,status:'pending'}]});
  await req('POST','/_test/reset',{body:seed});
  const tok=(await req('POST','/auth/login',{body:{email:'seed@example.com',password:'correct horse'}})).json.token;
  const b4=await req('GET','/me',{headers:{Authorization:`Bearer ${tok}`}});
  const ids=new Set(); let bad=null;
  for(let i=0;i<200;i++){ const s=await req('POST','/auth/signup',{body:{email:`n${i}@example.com`,password:'correct horse',display_name:`N${i}`}});
    if(s.status!==201){bad=`signup ${i} -> ${s.status}`;break;} const id=s.json.user_id;
    if(ids.has(id)||id==='u_1'||id==='u_2') bad=`collision ${id}`; if(id.length>64) bad=`id too long ${id.length}`; ids.add(id); }
  const af=await req('GET','/me',{headers:{Authorization:`Bearer ${tok}`}});
  ok('W2b.2','D27: 200 signups against a u_1/u_2/p_1/rq_1 fixture collide with nothing, and the seeded token still resolves to u_1/10000',
     bad===null&&ids.size===200&&af.status===200&&af.json?.user_id==='u_1'&&af.json?.balance===10000&&b4.text===af.text, bad||`ids ${ids.size}; /me ${af.status} ${af.text.slice(0,120)}`);
  const conc=await Promise.all(Array.from({length:50},(_,i)=>req('POST','/auth/signup',{body:{email:`cc${i}@example.com`,password:'correct horse',display_name:`C${i}`}})));
  const cids=conc.map(r=>r.json?.user_id);
  const s2=await st();
  ok('W2b.2b','D27 under concurrency: 50 simultaneous signups -> 50 distinct ids, R1.7 total still equals seeded_total',
     conc.every(r=>r.status===201)&&new Set(cids).size===50&&s2.users.reduce((a,u)=>a+u.balance,0)===s2.seeded_total,
     `201s ${conc.filter(r=>r.status===201).length} distinct ${new Set(cids).size} total ${s2.users.reduce((a,u)=>a+u.balance,0)} vs ${s2.seeded_total}`); }
{ const e=await req('GET','/_test/export');
  const keys=Object.keys(e.json?.state||{}).sort();
  ok('W2b.3',`export -> 200 {track,format_version,state}; state keys: ${keys.join(',')}`,
     e.status===200&&e.json.track==='pocketful'&&e.json.format_version===1&&e.json.state&&typeof e.json.state==='object'&&!Array.isArray(e.json.state)
     &&/application\/json;\s*charset=utf-8/i.test(e.ct||''), `${e.status} ct=${e.ct} track=${e.json?.track} v=${e.json?.format_version}`); }
{ await req('POST','/_test/reset',{body:fx({users:[U(1)]})}); let s=await st();
  const abs=Array.isArray(s.settlement_operator_ids)&&s.settlement_operator_ids.length===0;
  await req('POST','/_test/reset',{body:fx({users:[U(1)],settlement_operator_ids:['u_1']})}); s=await st();
  const kept=JSON.stringify(s.settlement_operator_ids)==='["u_1"]';
  const bad=await req('POST','/_test/reset',{body:fx({users:[U(1)],settlement_operator_ids:['u_ghost']})});
  const after=await st();
  ok('W2b.4','settlement_operator_ids: absent -> [], supplied -> retained and visible in the export, unknown id -> 422 with no state change',
     abs&&kept&&bad.status===422&&bad.json?.error?.code==='validation_failed'&&JSON.stringify(after.settlement_operator_ids)==='["u_1"]',
     `absent=${abs} kept=${kept} unknown=${bad.status}/${bad.json?.error?.code} after=${JSON.stringify(after.settlement_operator_ids)}`); }
{ const n=await req('GET','/_test/export');
  const g=await req('GET','/_test/export',{headers:{Authorization:'Bearer garbage'}});
  const j=await req('GET','/_test/export',{headers:{Authorization:'!!!'}});
  const q=await req('GET','/_test/export?limit=3&bogus=1');
  ok('W2b.5','export answers with no Authorization header, a garbage one, and unknown query params (R10.1, R3.4d)',
     n.status===200&&g.status===200&&j.status===200&&q.status===200, `${n.status}/${g.status}/${j.status}/${q.status}`); }
{ await req('POST','/_test/reset',{body:fx({users:[U(1,{password:'sup3r-s3cret-plaintext'})]})});
  await req('POST','/auth/signup',{body:{email:'sg@example.com',password:'another-plaintext-xyz',display_name:'S'}});
  const e=await req('GET','/_test/export');
  ok('W2b.6','no plaintext password anywhere in the export (seeded or signed-up)',
     !e.text.includes('sup3r-s3cret-plaintext')&&!e.text.includes('another-plaintext-xyz'), 'plaintext found');
  const hs=e.json.state.users.map(u=>u.password_hash);
  ok('W2b.6b','every stored hash is scrypt:<cost>:<salt>:<digest> with the cost encoded (D26)',
     hs.every(h=>/^scrypt:[0-9]+:[0-9a-f]{32}:[0-9a-f]{128}$/.test(h)), JSON.stringify(hs.map(h=>h.slice(0,16)))); }
{ const users=[U(1,{password:'shared pw'}),U(2,{password:'shared pw'}),U(3,{password:'shared pw'}),U(4,{password:'different pw'})];
  await req('POST','/_test/reset',{body:fx({users})});
  const e=await req('GET','/_test/export'); const hs=e.json.state.users.map(u=>u.password_hash);
  const counts={}; hs.forEach(h=>counts[h]=(counts[h]||0)+1);
  ok('W2b.6c','R6.11: users sharing a password must not share one stored hash (the export must not publish password equality)',
     new Set(hs).size===hs.length, `${new Set(hs).size} distinct hashes for ${hs.length} users; group sizes ${JSON.stringify(Object.values(counts))}`); }

console.log('\n########## W3 — authentication, handles, GET /me ##########');
await req('POST','/_test/reset',{body:A});
{ const l=await req('POST','/auth/login',{body:{email:'ada@example.com',password:'correct horse'}});
  const m=await req('GET','/me',{headers:{Authorization:`Bearer ${l.json?.token}`}});
  ok('W3.1','seeded user logs in -> 200 + token; /me returns all six seeded fields',
     l.status===200&&!!l.json.token&&m.status===200&&m.json.user_id==='u_1'&&m.json.display_name==='Ada'&&m.json.handle==='ada'&&m.json.balance===10000&&m.json.currency==='EUR'&&m.json.minor_units===2,
     `${l.status} ${m.status} ${m.text.slice(0,200)}`); }
{ const s=await req('POST','/auth/signup',{body:{email:'new@example.com',password:'correct horse',display_name:'New'}});
  const m=await req('GET','/me',{headers:{Authorization:`Bearer ${s.json?.token}`}});
  ok('W3.2','signup -> 201 with a working token; /me balance 0', s.status===201&&!!s.json.token&&m.status===200&&m.json.balance===0, `${s.status} ${m.status} ${m.text.slice(0,160)}`); }
{ const mk=async(email)=>{const r=await req('POST','/auth/signup',{body:{email,password:'correct horse',display_name:'X'}});
   if(r.status!==201) return {err:`${r.status} ${r.text.slice(0,100)}`};
   const m=await req('GET','/me',{headers:{Authorization:`Bearer ${r.json.token}`}}); return {h:m.json.handle};};
  await req('POST','/_test/reset',{body:A});
  const a=await mk('Ada.Lovelace+x@example.com');
  const long=await mk('a'.repeat(30)+'@example.com');
  const re=/^[a-z0-9_]{1,20}$/;
  ok('W3.3',`derivation: Ada.Lovelace+x -> ${a.h}; 30-char local truncates to ${long.h?.length}`,
     a.h==='ada_lovelace_x'&&long.h?.length===20&&re.test(a.h)&&re.test(long.h), JSON.stringify([a,long])); }
{ await req('POST','/_test/reset',{body:A});
  const i1=await mkH('İstanbul@x.com'), i2=await mkH('İ@example.com');
  ok('W3.4',`C3 stated order: İstanbul -> ${i1}; İ -> ${i2} (lowercase THEN replace)`, i1==='i_stanbul'&&i2==='i_', JSON.stringify([i1,i2])); }
{ await req('POST','/_test/reset',{body:A});
  const e=await mkH('\u{1F600}\u{1F601}@example.com');
  ok('W3.5',`D21: two emoji code points -> ${JSON.stringify(e)} (one underscore each, not two)`, e==='__', JSON.stringify(e)); }
async function mkH(email){const r=await req('POST','/auth/signup',{body:{email,password:'correct horse',display_name:'X'}});
  if(r.status!==201) return `ERR ${r.status} ${r.text.slice(0,80)}`;
  return (await req('GET','/me',{headers:{Authorization:`Bearer ${r.json.token}`}})).json.handle;}
{ await req('POST','/_test/reset',{body:A});
  const dup=await req('POST','/auth/signup',{body:{email:'ada@example.com',password:'correct horse',display_name:'D'}});
  const clash=await req('POST','/auth/signup',{body:{email:'ada@other.com',password:'correct horse',display_name:'D'}});
  const after=await req('POST','/auth/login',{body:{email:'ada@other.com',password:'correct horse'}});
  ok('W3.6','duplicate email -> 409 email_taken; taken derived handle -> 409 handle_taken and NO account created (login 401)',
     dup.status===409&&dup.json?.error?.code==='email_taken'&&clash.status===409&&clash.json?.error?.code==='handle_taken'&&after.status===401,
     `${dup.status}/${dup.json?.error?.code} ${clash.status}/${clash.json?.error?.code} login ${after.status}`); }
{ const r=[]; for(const [l,b] of [['7-char password',{email:'p7@example.com',password:'1234567',display_name:'X'}],
   ['notanemail',{email:'notanemail',password:'correct horse',display_name:'X'}],
   ['a@b@c',{email:'a@b@c',password:'correct horse',display_name:'X'}],
   ['@d.com',{email:'@d.com',password:'correct horse',display_name:'X'}]]){
   const x=await req('POST','/auth/signup',{body:b}); if(!(x.status===422&&x.json?.error?.code==='validation_failed')) r.push(`${l} -> ${x.status}/${x.json?.error?.code}`);}
  ok('W3.7','7-char password, notanemail, a@b@c and @d.com all -> 422 validation_failed', r.length===0, r.join(' | ')); }
{ const w=await req('POST','/auth/login',{body:{email:'ada@example.com',password:'wrong password'}});
  const u=await req('POST','/auth/login',{body:{email:'ghost@example.com',password:'correct horse'}});
  ok('W3.8','wrong password -> 401; unknown email -> 401 (same code and message)',
     w.status===401&&u.status===401&&w.json?.error?.code==='unauthenticated'&&w.text===u.text, `${w.status}/${u.status}; bodies ${w.text===u.text?'identical':'DIFFER: '+w.text+' vs '+u.text}`); }
{ const t=[]; for(let i=0;i<3;i++) t.push((await req('POST','/auth/login',{body:{email:'ada@example.com',password:'correct horse'}})).json.token);
  const res=[]; for(const x of t) res.push((await req('GET','/me',{headers:{Authorization:`Bearer ${x}`}})).status);
  ok('W3.9','three logins yield three distinct tokens, all still working afterwards', new Set(t).size===3&&res.every(s=>s===200), `distinct ${new Set(t).size} statuses ${res.join(',')}`); }
{ const e=await req('GET','/_test/export');
  ok('W3.10','no plaintext fixture password ("correct horse") anywhere in the export', !e.text.includes('correct horse'), 'plaintext found'); }
{ const cases=[['no header',{}],['garbage token',{Authorization:'Bearer garbage-not-a-token'}],['empty token',{Authorization:'Bearer '}],
   ['scheme only',{Authorization:'Bearer'}],['no scheme',{Authorization:'abcdef'}],['wrong scheme',{Authorization:'Basic abcdef'}],['empty header',{Authorization:''}]];
  const bad=[]; for(const [l,h] of cases){ const r=await req('GET','/me',{headers:h});
   if(!(r.status===401&&r.json?.error?.code==='unauthenticated')) bad.push(`${l} -> ${r.status}/${r.json?.error?.code}`);}
  ok('W3.11','GET /me (the only protected endpoint at this commit) rejects all seven bad-auth shapes with 401 unauthenticated', bad.length===0, bad.join(' | ')); }
{ const s=await req('POST','/auth/signup',{body:{email:'empty-dn@example.com',password:'correct horse',display_name:''}});
  const m=await req('GET','/me',{headers:{Authorization:`Bearer ${s.json?.token}`}});
  const abs=await req('POST','/auth/signup',{body:{email:'no-dn@example.com',password:'correct horse'}});
  ok('W3.12','D34: display_name "" -> 201 and /me returns ""; display_name absent -> 422 validation_failed',
     s.status===201&&m.json?.display_name===''&&abs.status===422&&abs.json?.error?.code==='validation_failed',
     `"" -> ${s.status}, /me display_name ${JSON.stringify(m.json?.display_name)}, absent -> ${abs.status}/${abs.json?.error?.code}`); }
{ const tok=(await req('POST','/auth/login',{body:{email:'ada@example.com',password:'correct horse'}})).json.token;
  const good=[]; for(const s of ['Bearer','bearer','BEARER','BeArEr']) good.push((await req('GET','/me',{headers:{Authorization:`${s} ${tok}`}})).status);
  const basic=await req('GET','/me',{headers:{Authorization:`Basic ${tok}`}});
  const upper=await req('GET','/me',{headers:{Authorization:`Bearer ${tok.toUpperCase()}`}});
  ok('W3.13','D35: bearer/BEARER/BeArEr all 200; Basic -> 401; a case-altered token -> 401 (the /i flag does not reach the token)',
     good.every(s=>s===200)&&basic.status===401&&upper.status===401, `schemes ${good.join(',')} basic ${basic.status} uppercased-token ${upper.status}`); }
{ await req('POST','/_test/reset',{body:A});
  const burst=await Promise.all(Array.from({length:30},(_,i)=>req('POST','/auth/login',{body:{email:`ghost${i}@example.com`,password:'correct horse'}})));
  const s=await st();
  ok('W3.14','D36: a burst of 30 unknown-email logins all 401, and the export still holds exactly the 2 seeded users (the dummy hash never reaches state)',
     burst.every(r=>r.status===401)&&s.users.length===2&&s.users.every(u=>['u_1','u_2'].includes(u.id)),
     `401s ${burst.filter(r=>r.status===401).length}/30; export users ${JSON.stringify(s.users.map(u=>u.id))}`); }
console.log(`\n==== CRITERIA TOTAL: ${pass} pass, ${fail} fail ====`);
if(F.length){console.log('FAILED:');F.forEach((f,i)=>console.log(` ${i+1}. ${f}`));}
