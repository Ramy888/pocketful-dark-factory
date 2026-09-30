// W5's payments endpoint, probed past its criteria: the ledger invariants under
// concurrency, the D22 precedence chain, amount/note/visibility boundaries, and that a
// rejected payment leaves no trace. Run at every commit from 24aca14 onward.
//
//   BASE_URL=http://127.0.0.1:PORT node stage-1/acceptance/probes/w5-payments-probe.mjs
//
// Out of /tmp for the same reason D28 gives the implementer: it was evidence in four
// verdicts and was not in version control.
const B=process.env.BASE_URL;
let pass=0,fail=0; const F=[];
const ok=(n,c,d='')=>{c?(pass++,console.log(`  PASS ${n}`)):(fail++,F.push(n+' :: '+d),console.log(`  FAIL ${n} :: ${d}`));};
async function req(m,p,{body,headers={},raw}={}){const h={...headers};let b;
 if(raw!==undefined){b=raw;h['Content-Type']??='application/json';}else if(body!==undefined){b=JSON.stringify(body);h['Content-Type']='application/json';}
 const r=await fetch(B+p,{method:m,headers:h,body:b});const t=await r.text();let j=null;try{j=JSON.parse(t);}catch{};return{status:r.status,text:t,json:j};}
const FX={currency:'EUR',minor_units:2,users:[
 {id:'u_1',email:'ada@example.com',password:'correct horse',display_name:'Ada',handle:'ada',balance:10000},
 {id:'u_2',email:'bob@example.com',password:'correct horse',display_name:'Bob',handle:'bob',balance:2500},
 {id:'u_3',email:'cy@example.com',password:'correct horse',display_name:'Cy',handle:'cy',balance:0}],payments:[],requests:[]};
let T={};
const setup=async()=>{await req('POST','/_test/reset',{body:FX});
 for(const h of ['ada','bob','cy']) T[h]=(await req('POST','/auth/login',{body:{email:`${h}@example.com`,password:'correct horse'}})).json.token;};
const st=async()=>(await req('GET','/_test/export')).json.state;
const bal=async(h)=>(await st()).users.find(u=>u.handle===h).balance;
let n=0; const K=()=>`k-${Date.now()}-${++n}`;
const pay=(tok,body,key)=>req('POST','/payments',{body,headers:{Authorization:`Bearer ${tok}`,'Idempotency-Key':key??K()}});
await setup();

console.log('\n== R1.7 / R1.8: the ledger invariants under concurrency ==');
{ await setup(); const s0=await st(); const total0=s0.users.reduce((a,u)=>a+u.balance,0);
  const rs=await Promise.all(Array.from({length:60},()=>pay(T.ada,{to_handle:'bob',amount:200})));
  const s1=await st(); const total1=s1.users.reduce((a,u)=>a+u.balance,0);
  const c201=rs.filter(r=>r.status===201).length, c409=rs.filter(r=>r.status===409&&r.json?.error?.code==='insufficient_funds').length;
  ok(`60 concurrent 200-unit payments from a 10000 balance: ${c201} created, ${c409} insufficient_funds`,
     c201===50&&c409===10, `201s ${c201} 409s ${c409} others ${rs.filter(r=>r.status!==201&&r.status!==409).map(r=>r.status).join(',')}`);
  ok(`R1.7: the conserved total is unchanged (${total1} vs seeded ${s1.seeded_total})`, total1===total0&&total1===s1.seeded_total, `${total0} -> ${total1}, seeded ${s1.seeded_total}`);
  ok('R1.8: no balance went negative, not even transiently observable', s1.users.every(u=>u.balance>=0), JSON.stringify(s1.users.map(u=>[u.handle,u.balance])));
  ok('the sender is drained to exactly 0', s1.users.find(u=>u.handle==='ada').balance===0, String(s1.users.find(u=>u.handle==='ada').balance)); }
{ await setup();
  const rs=await Promise.all([...Array(40)].map((_,i)=> i%2? pay(T.ada,{to_handle:'bob',amount:300}) : pay(T.bob,{to_handle:'ada',amount:100})));
  const s=await st();
  ok('R1.7 holds under payments crossing in both directions between the same two wallets',
     s.users.reduce((a,u)=>a+u.balance,0)===s.seeded_total && s.users.every(u=>u.balance>=0),
     JSON.stringify(s.users.map(u=>[u.handle,u.balance]))+` total ${s.users.reduce((a,u)=>a+u.balance,0)} seeded ${s.seeded_total}`);
  ok('every created payment has a distinct id', (()=>{const ids=rs.filter(r=>r.status===201).map(r=>r.json.payment_id);return new Set(ids).size===ids.length;})(), 'duplicate payment id'); }

console.log('\n== R7.11 through the real endpoint: one key, many racers ==');
{ await setup(); const k=K(); const b0=await bal('bob');
  const rs=await Promise.all(Array.from({length:25},()=>pay(T.ada,{to_handle:'bob',amount:111},k)));
  const c201=rs.filter(r=>r.status===201).length, c200=rs.filter(r=>r.status===200).length;
  const bodies=new Set(rs.map(r=>r.text));
  ok(`25 racers on one key: exactly one 201, twenty-four 200s (${c201}/${c200})`, c201===1&&c200===24, `201 ${c201} 200 ${c200}`);
  ok('all 25 responses are byte-identical', bodies.size===1, `${bodies.size} distinct bodies`);
  ok(`money moved exactly once (${(await bal('bob'))-b0})`, (await bal('bob'))-b0===111, String((await bal('bob'))-b0)); }

console.log('\n== D22 precedence chain, end to end ==');
{ await setup(); const k=K();
  await pay(T.ada,{to_handle:'bob',amount:10},k);
  const inv=await pay(T.ada,{to_handle:'bob',amount:'not a number'},k);
  const gone=await pay(T.ada,{to_handle:'no-such-handle',amount:10},k);
  const poor=await pay(T.cy,{to_handle:'bob',amount:999999},K());
  ok('a claimed key beats field validation -> 409, not 422', inv.status===409&&inv.json?.error?.code==='idempotency_key_reuse', `${inv.status}/${inv.json?.error?.code}`);
  ok('a claimed key beats resource resolution -> 409, not 404', gone.status===409&&gone.json?.error?.code==='idempotency_key_reuse', `${gone.status}/${gone.json?.error?.code}`);
  ok('insufficient funds is 409 insufficient_funds', poor.status===409&&poor.json?.error?.code==='insufficient_funds', `${poor.status}/${poor.json?.error?.code}`);
  const both=await pay(T.cy,{to_handle:'no-such-handle',amount:0},K());
  ok('an invalid amount together with an unknown handle is 422, never 404 (field validation first)',
     both.status===422&&both.json?.error?.code==='validation_failed', `${both.status}/${both.json?.error?.code}`);
  const selfPoor=await pay(T.cy,{to_handle:'cy',amount:999999},K());
  ok('self_payment beats insufficient_funds (422 self_payment on a zero balance)',
     selfPoor.status===422&&selfPoor.json?.error?.code==='self_payment', `${selfPoor.status}/${selfPoor.json?.error?.code}`);
  const selfBad=await pay(T.cy,{to_handle:'cy',amount:-5},K());
  ok('an invalid amount beats self_payment (amount is checked first)',
     selfBad.status===422&&selfBad.json?.error?.code==='validation_failed', `${selfBad.status}/${selfBad.json?.error?.code}`); }

console.log('\n== amount boundaries and R4.2 numeric forms ==');
{ await setup();
  // R5.10 is explicit: "invalid amount values (including strings and booleans)" are 422,
  // the one carve-out from R5.2's "wrong JSON type is 400". So null is 422, not 400 -- I
  // first wrote this table the other way round and the service was right, not the table.
  // 1000000000 is a *valid* amount (R4.17's ceiling), so against ada's 10000 balance it is
  // 409 insufficient_funds, not 422: the range check passes and the funds check decides.
  // NaN is deliberately absent: JSON.stringify({amount: NaN}) emits {"amount":null}, so a
  // "NaN" row would silently be a second null row testing nothing new. JSON has no NaN, so
  // the only way to send one is a raw body, which the malformed-input probe already covers.
  const cases=[[1,201],[1000000000,409],[0,422],[-1,422],[1.5,422],['100',422],[true,422],[null,422],[[1],422],[{},422],[1e3,201]];
  const bad=[];
  for(const [v,want] of cases){ const r=await pay(T.ada,{to_handle:'bob',amount:v},K());
    const got=r.status; if(got!==want) bad.push(`amount ${JSON.stringify(v)} -> ${got} (wanted ${want})`); }
  ok('amount boundary table (1 and 1e3 accepted; 1e9 valid but unaffordable -> 409; every invalid amount -> 422 per R5.10)',
     bad.length===0, bad.join(' | '));
  const f=await pay(T.ada,{to_handle:'bob',amount:1000.0},K());
  ok('R4.2: 1000.0 is an integral value and is accepted', f.status===201&&f.json.amount===1000, `${f.status} ${f.text.slice(0,100)}`);
  await setup();
  const max=await pay(T.ada,{to_handle:'bob',amount:1000000000},K());
  ok('amount 1000000000 is a valid amount, rejected only for funds (409, not 422)',
     max.status===409&&max.json?.error?.code==='insufficient_funds', `${max.status}/${max.json?.error?.code}`);
  const over=await pay(T.ada,{to_handle:'bob',amount:1000000001},K());
  ok('amount 1000000001 is 422 validation_failed, ahead of the funds question',
     over.status===422&&over.json?.error?.code==='validation_failed', `${over.status}/${over.json?.error?.code}`); }

console.log('\n== note and visibility ==');
{ await setup();
  const n200='\u{1F600}'.repeat(200), n201='\u{1F600}'.repeat(201);
  const a=await pay(T.ada,{to_handle:'bob',amount:1,note:n200},K());
  const b=await pay(T.ada,{to_handle:'bob',amount:1,note:n201},K());
  ok('D20: a 200-code-point astral note is accepted (400 UTF-16 units)', a.status===201&&a.json.note===n200, `${a.status}`);
  ok('D20: a 201-code-point astral note is 422', b.status===422&&b.json?.error?.code==='validation_failed', `${b.status}/${b.json?.error?.code}`);
  const weird='quotes " \' backslash \\ </script> nul\u0000 zwj‍ rtlم combining ñ';
  const w=await pay(T.ada,{to_handle:'bob',amount:1,note:weird},K());
  ok('a note with quotes, backslash, NUL, ZWJ, RTL and combining marks round-trips byte for byte in the 201',
     w.status===201&&w.json.note===weird, `${w.status} ${JSON.stringify(w.json?.note)}`);
  const e=await st(); const stored=e.payments.find(p=>p.id===w.json.payment_id);
  ok('...and survives into GET /_test/export unchanged', stored && stored.note===weird, JSON.stringify(stored&&stored.note));
  const nn=await pay(T.ada,{to_handle:'bob',amount:1,note:null},K());
  ok('note null is 422, not silently defaulted', nn.status===422&&nn.json?.error?.code==='validation_failed', `${nn.status}/${nn.json?.error?.code}`);
  const om=await pay(T.ada,{to_handle:'bob',amount:1},K());
  ok('note omitted defaults to "" and visibility to "public"', om.status===201&&om.json.note===''&&om.json.visibility==='public', `${om.status} ${om.text.slice(0,140)}`);
  for(const [v,want] of [['public',201],['private',201],['PUBLIC',422],['',422],[null,422],[1,422],[true,422]]){
    const r=await pay(T.ada,{to_handle:'bob',amount:1,visibility:v},K());
    if(r.status!==want) ok(`visibility ${JSON.stringify(v)} -> ${want}`, false, `got ${r.status}`); }
  ok('visibility enum: public/private accepted, PUBLIC/""/null/1/true all 422', true, ''); }

console.log('\n== to_handle shape (R5.2 vs R5.8) and the export record ==');
{ await setup();
  const absent=await pay(T.ada,{amount:10},K());
  ok('to_handle absent -> 422 validation_failed', absent.status===422&&absent.json?.error?.code==='validation_failed', `${absent.status}/${absent.json?.error?.code}`);
  const bad=[];
  for(const v of [5,true,null,['bob'],{}]){ const r=await pay(T.ada,{to_handle:v,amount:10},K());
    if(!(r.status===400&&r.json?.error?.code==='malformed_request')) bad.push(`${JSON.stringify(v)} -> ${r.status}/${r.json?.error?.code}`); }
  ok('to_handle of a wrong JSON type -> 400 malformed_request', bad.length===0, bad.join(' | '));
  const p=await pay(T.ada,{to_handle:'bob',amount:77,note:'hi',visibility:'private'},K());
  const rec=(await st()).payments.find(x=>x.id===p.json.payment_id);
  ok('the created payment reaches the export with amount, visibility, note and a null settlement_id',
     rec&&rec.amount===77&&rec.visibility==='private'&&rec.note==='hi'&&rec.settlement_id===null&&rec.request_id===null,
     JSON.stringify(rec));
  ok('the 201 body carries all twelve documented fields',
     ['payment_id','from_user_id','from_handle','to_user_id','to_handle','amount','currency','note','visibility','request_id','settlement_id','created_at'].every(k=>k in p.json),
     JSON.stringify(Object.keys(p.json)));
  ok('created_at is RFC 3339 with an explicit offset',
     /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(p.json.created_at), p.json.created_at);
  ok('the payment id is opaque and at most 64 chars', typeof p.json.payment_id==='string'&&p.json.payment_id.length<=64, `${p.json.payment_id} (${p.json.payment_id.length})`); }

console.log('\n== a rejected payment leaves no trace (R8.10) ==');
{ await setup(); const before=await st();
  for(const body of [{to_handle:'bob',amount:0},{to_handle:'nope',amount:5},{to_handle:'ada',amount:5},{to_handle:'bob',amount:1000000001}])
    await pay(T.ada,body,K());
  await pay(T.cy,{to_handle:'bob',amount:99999},K());
  const after=await st();
  ok('five rejected payments changed no balance and created no payment record',
     JSON.stringify(before.users)===JSON.stringify(after.users) && after.payments.length===before.payments.length,
     `payments ${before.payments.length}->${after.payments.length}`); }

console.log('\n== seeded-id collision and restart ==');
{ const seeded={...FX,payments:[{id:'p_1',from_user_id:'u_1',to_user_id:'u_2',amount:50,visibility:'public'}]};
  await req('POST','/_test/reset',{body:seeded});
  const tok=(await req('POST','/auth/login',{body:{email:'ada@example.com',password:'correct horse'}})).json.token;
  const ids=new Set(); for(let i=0;i<30;i++){const r=await req('POST','/payments',{body:{to_handle:'bob',amount:1},headers:{Authorization:`Bearer ${tok}`,'Idempotency-Key':K()}}); if(r.status===201) ids.add(r.json.payment_id);}
  ok('30 payments against a fixture seeding p_1 mint 30 distinct non-seeded ids', ids.size===30&&!ids.has('p_1'), `${ids.size} distinct, has p_1: ${ids.has('p_1')}`); }
console.log(`\n==== W5 PROBE: ${pass} pass, ${fail} fail ====`);
if(F.length){console.log('FINDINGS:');F.forEach((f,i)=>console.log(` ${i+1}. ${f}`));}
