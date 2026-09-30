// W10's settlements, probed past its criteria, across two containers.
// Requires BASE_URL and ALT_BASE_URL.
//
//   BASE_URL=http://127.0.0.1:A ALT_BASE_URL=http://127.0.0.1:B node .../w10-settlements-probe.mjs
//
// Includes the matched affordability pair published before the build: a chain affordable only
// as a net must commit, AND the same batch with the draining transfer listed first must also
// commit. An implementation checking transfers sequentially passes the first and fails the
// second, so either case alone establishes nothing about the rule.
const A=process.env.BASE_URL, Bb=process.env.ALT_BASE_URL;
let pass=0,fail=0; const F=[];
const ok=(id,n,c,d='')=>{c?(pass++,console.log(`  PASS [${id}] ${n}`)):(fail++,F.push(`[${id}] ${n} :: ${d}`),console.log(`  FAIL [${id}] ${n} :: ${d}`));};
const rq=async(base,m,p,{body,headers={},raw}={})=>{const h={...headers};let b;
 if(raw!==undefined){b=raw;h['Content-Type']??='application/json';}else if(body!==undefined){b=JSON.stringify(body);h['Content-Type']='application/json';}
 const r=await fetch(base+p,{method:m,headers:h,body:b});const t=await r.text();let j=null;try{j=JSON.parse(t);}catch{};return{status:r.status,text:t,json:j};};
const HS=['ada','bob','cy','op','rich'];
const FX={currency:'EUR',minor_units:2,users:[
 {id:'u_ada',email:'ada@e.com',password:'correct horse',display_name:'Ada',handle:'ada',balance:10000},
 {id:'u_bob',email:'bob@e.com',password:'correct horse',display_name:'Bob',handle:'bob',balance:50},
 {id:'u_cy', email:'cy@e.com', password:'correct horse',display_name:'Cy', handle:'cy', balance:0},
 {id:'u_op', email:'op@e.com', password:'correct horse',display_name:'Op', handle:'op', balance:0},
 {id:'u_rich',email:'rich@e.com',password:'correct horse',display_name:'R',handle:'rich',balance:2000000000}],
 payments:[],requests:[],settlement_operator_ids:['u_op']};
let T={}; let n=0; const K=()=>`w10-${++n}-${Date.now()}`;
const AU=(t)=>({Authorization:`Bearer ${t}`});
const setup=async(base=A)=>{await rq(base,'POST','/_test/reset',{body:FX});
 for(const h of HS) T[h]=(await rq(base,'POST','/auth/login',{body:{email:`${h}@e.com`,password:'correct horse'}})).json.token;};
const settle=(transfers,tok=T.op,k)=>rq(A,'POST','/settlements',{body:{transfers},headers:{...AU(tok),'Idempotency-Key':k??K()}});
const Tr=(f,t,a,extra={})=>({from_handle:f,to_handle:t,amount:a,...extra});
const st=async(base=A)=>(await rq(base,'GET','/_test/export')).json.state;
const bal=async(h,base=A)=>(await st(base)).users.find(u=>u.handle===h).balance;
await setup();

console.log('\n== criteria 1, 2: the envelope and settlement_id linkage ==');
{ const r=await settle([Tr('ada','bob',100),Tr('bob','cy',50)]);
  ok(1,'201 with settlement_id, committed_at and payments in input order',
     r.status===201&&!!r.json.settlement_id&&!!r.json.committed_at&&r.json.payments.length===2&&
     r.json.payments[0].from_handle==='ada'&&r.json.payments[1].from_handle==='bob', `${r.status} ${r.text.slice(0,180)}`);
  const stamps=new Set(r.json.payments.map(p=>p.created_at));
  ok('1b','every member carries the batch settlement_id, request_id null, one shared created_at equal to committed_at',
     r.json.payments.every(p=>p.settlement_id===r.json.settlement_id&&p.request_id===null&&p.created_at===r.json.committed_at)&&stamps.size===1,
     JSON.stringify(r.json.payments.map(p=>[p.settlement_id===r.json.settlement_id,p.request_id,p.created_at])));
  const ord=await rq(A,'POST','/payments',{body:{to_handle:'bob',amount:1},headers:{...AU(T.ada),'Idempotency-Key':K()}});
  ok(2,'an ordinary POST /payments has settlement_id null', ord.json.settlement_id===null, JSON.stringify(ord.json.settlement_id)); }

console.log('\n== criteria 3, 16: authorisation, and D15 before the key ==');
{ await setup();
  const noTok=await rq(A,'POST','/settlements',{body:{transfers:[Tr('ada','bob',1)]},headers:{'Idempotency-Key':K()}});
  const nonOp=await rq(A,'POST','/settlements',{body:{transfers:[Tr('ada','bob',1)]},headers:{...AU(T.ada),'Idempotency-Key':K()}});
  ok(3,'no token -> 401; authenticated non-operator -> 403 forbidden',
     noTok.status===401&&nonOp.status===403&&nonOp.json?.error?.code==='forbidden', `${noTok.status}/${nonOp.status}`);
  const nonOpNoKey=await rq(A,'POST','/settlements',{body:{transfers:[Tr('ada','bob',1)]},headers:AU(T.ada)});
  ok(16,'D15: a non-operator with NO idempotency key gets 403, not 400',
     nonOpNoKey.status===403&&nonOpNoKey.json?.error?.code==='forbidden', `${nonOpNoKey.status}/${nonOpNoKey.json?.error?.code}`);
  const opNoKey=await rq(A,'POST','/settlements',{body:{transfers:[Tr('ada','bob',1)]},headers:AU(T.op)});
  ok('16b','but an OPERATOR with no key gets 400 missing_idempotency_key', opNoKey.status===400&&opNoKey.json?.error?.code==='missing_idempotency_key', `${opNoKey.status}/${opNoKey.json?.error?.code}`); }

console.log('\n== criterion 4 + the matched pair I published in advance ==');
{ await setup();
  const r=await settle([Tr('ada','bob',100),Tr('bob','cy',150)]);   // bob holds 50: 50+100-150 = 0
  ok(4,'a chain affordable only as a net commits (bob 50 +100 -150 = 0)', r.status===201, `${r.status} ${r.text.slice(0,140)}`);
  ok('4b','balances land exactly', (await bal('ada'))===9900&&(await bal('bob'))===0&&(await bal('cy'))===150,
     `ada ${await bal('ada')} bob ${await bal('bob')} cy ${await bal('cy')}`);
  await setup();
  const rev=await settle([Tr('bob','cy',150),Tr('ada','bob',100)]); // draining transfer FIRST
  ok('4c','THE MATCHED PAIR: the same batch with the draining transfer first also commits',
     rev.status===201, `${rev.status} ${rev.text.slice(0,140)} -- a sequential implementation fails exactly here`);
  ok('4d','and lands on identical balances regardless of order', (await bal('ada'))===9900&&(await bal('bob'))===0&&(await bal('cy'))===150,
     `ada ${await bal('ada')} bob ${await bal('bob')} cy ${await bal('cy')}`);
  await setup();
  const cyc=await settle([Tr('ada','bob',100),Tr('bob','ada',100)]);
  const s=await st();
  ok('4e','a zero-net cycle commits with TWO receipts and leaves balances unchanged',
     cyc.status===201&&cyc.json.payments.length===2&&(await bal('ada'))===10000&&(await bal('bob'))===50, `${cyc.status} receipts ${cyc.json?.payments?.length}`); }

console.log('\n== criterion 5: all-or-nothing, and the key is NOT claimed ==');
{ await setup(); const before=await st(); const k=K();
  const bad=await settle([Tr('ada','bob',100),Tr('bob','cy',200)],T.op,k);  // bob: 50+100-200 = -50
  const after=await st();
  ok(5,'a batch leaving one wallet negative -> 409 insufficient_funds', bad.status===409&&bad.json?.error?.code==='insufficient_funds', `${bad.status}/${bad.json?.error?.code}`);
  ok('5b','no payment created and no balance moved', JSON.stringify(before.users)===JSON.stringify(after.users)&&before.payments.length===after.payments.length,
     `payments ${before.payments.length}->${after.payments.length}`);
  const reuse=await settle([Tr('ada','bob',10)],T.op,k);
  ok('5c','the key was NOT claimed: the same key succeeds with a valid body', reuse.status===201, `${reuse.status} ${reuse.text.slice(0,140)}`); }

console.log('\n== criteria 6, 8, 15: shape, self-transfer, the fifth idempotent path ==');
{ await setup(); const bad=[];
  const cases=[['empty',[],422],['33 entries',Array.from({length:33},()=>Tr('rich','ada',1)),422],
               ['absent',undefined,422],['a string',"x",422],['a number',5,422],['true',true,422],['null',null,422],['an object',{a:1},422]];
  for(const [l,tv,want] of cases){
    const body=tv===undefined?{}:{transfers:tv};
    const r=await rq(A,'POST','/settlements',{body,headers:{...AU(T.op),'Idempotency-Key':K()}});
    if(r.status!==want||r.json?.error?.code!=='validation_failed') bad.push(`${l} -> ${r.status}/${r.json?.error?.code}`); }
  ok(6,'transfers empty/33/absent/non-array all -> 422 validation_failed (R11.7 carve-out from R5.2)', bad.length===0, bad.join(' | '));
  const t32=await settle(Array.from({length:32},()=>Tr('rich','ada',1)));
  ok('6b','32 transfers succeed with 32 receipts', t32.status===201&&t32.json.payments.length===32, `${t32.status} ${t32.json?.payments?.length}`);
  const self=await settle([Tr('ada','ada',1)]);
  ok(8,'a self transfer -> 422 self_payment', self.status===422&&self.json?.error?.code==='self_payment', `${self.status}/${self.json?.error?.code}`);
  const k=K(); await settle([Tr('ada','bob',5)],T.op,k);
  const diff=await settle([Tr('ada','bob',6)],T.op,k);
  const empty=await rq(A,'POST','/settlements',{body:{transfers:[Tr('ada','bob',1)]},headers:{...AU(T.op),'Idempotency-Key':''}});
  const long=await rq(A,'POST','/settlements',{body:{transfers:[Tr('ada','bob',1)]},headers:{...AU(T.op),'Idempotency-Key':'z'.repeat(256)}});
  ok(15,'fifth idempotent path: empty key 400, 256-char key 422, same key different body 409',
     empty.status===400&&empty.json?.error?.code==='missing_idempotency_key'&&long.status===422&&diff.status===409&&diff.json?.error?.code==='idempotency_key_reuse',
     `empty ${empty.status} long ${long.status} reuse ${diff.status}/${diff.json?.error?.code}`); }

console.log('\n== criterion 7: D23, entry errors in input order, before funds ==');
{ await setup(); const bad=[];
  const cases=[
   ['unaffordable, then unknown handle in e2, then self in e3',[Tr('ada','bob',99999),Tr('nobody','bob',1),Tr('cy','cy',1)],404,'not_found'],
   ['unaffordable, then self in e2',[Tr('ada','bob',99999),Tr('cy','cy',1)],422,'self_payment'],
   ['self in e1, unknown in e2',[Tr('cy','cy',1),Tr('nobody','bob',1)],422,'self_payment'],
   ['unknown in e1, self in e2',[Tr('nobody','bob',1),Tr('cy','cy',1)],404,'not_found'],
   ['bad amount e1, unknown e2',[Tr('ada','bob',0),Tr('nobody','bob',1)],422,'validation_failed'],
   ['valid e1, self e2, unknown e3',[Tr('ada','bob',1),Tr('cy','cy',1),Tr('nobody','bob',1)],422,'self_payment'],
  ];
  const before=await st();
  for(const [l,tr,ws,wc] of cases){ const r=await settle(tr);
    if(r.status!==ws||r.json?.error?.code!==wc) bad.push(`${l} -> ${r.status}/${r.json?.error?.code} (wanted ${ws}/${wc})`); }
  const after=await st();
  ok(7,'entry errors are reported in input order and always before insufficient funds', bad.length===0, bad.join(' | '));
  ok('7b','none of those rejected batches moved anything', JSON.stringify(before.users)===JSON.stringify(after.users), 'a rejected batch moved money'); }

console.log('\n== criteria 9, 17, 10: per-entry note/visibility and feed visibility ==');
{ await setup();
  const r=await settle([Tr('ada','bob',10,{note:'lunch',visibility:'private',unknown_field:'ignored'}),Tr('ada','cy',20)]);
  ok(9,'unknown fields ignored; note and visibility honoured with defaults "" and public',
     r.status===201&&r.json.payments[0].note==='lunch'&&r.json.payments[0].visibility==='private'&&
     r.json.payments[1].note===''&&r.json.payments[1].visibility==='public', JSON.stringify(r.json.payments?.map(p=>[p.note,p.visibility])));
  const third=await rq(A,'GET','/activity?limit=200',{headers:AU(T.rich)});
  const ids=(third.json.payments||[]).map(p=>p.payment_id);
  ok(10,'a private member is hidden from a third party, the public one is visible',
     !ids.includes(r.json.payments[0].payment_id)&&ids.includes(r.json.payments[1].payment_id),
     `third party sees ${ids.length}`);
  ok('10b','...but the settlement RESPONSE still contains every member', r.json.payments.length===2, `${r.json.payments.length}`); }

console.log('\n== criterion 12: operator permission grants no read access ==');
{ await setup();
  const priv=await rq(A,'POST','/payments',{body:{to_handle:'bob',amount:7,visibility:'private'},headers:{...AU(T.ada),'Idempotency-Key':K()}});
  await rq(A,'POST','/requests',{body:{payer_handle:'bob',amount:9},headers:{...AU(T.ada),'Idempotency-Key':K()}});
  const opFeed=await rq(A,'GET','/activity?limit=200',{headers:AU(T.op)});
  const opReqs=await rq(A,'GET','/requests?limit=200',{headers:AU(T.op)});
  ok(12,"an operator sees neither another user's private payment nor their requests",
     !(opFeed.json.payments||[]).some(p=>p.payment_id===priv.json.payment_id)&&(opReqs.json.requests||[]).length===0,
     `feed ${(opFeed.json.payments||[]).length} reqs ${(opReqs.json.requests||[]).length}`); }

console.log('\n== criterion 11: replay ==');
{ await setup(); const k=K();
  const first=await settle([Tr('ada','bob',25),Tr('bob','cy',10)],T.op,k);
  const b0=await bal('cy');
  const again=await settle([Tr('ada','bob',25),Tr('bob','cy',10)],T.op,k);
  ok(11,'replay -> 200 with the original complete response, byte-identical',
     again.status===200&&again.text===first.text, `${again.status} identical=${again.text===first.text}`);
  ok('11b','and moved no further money', (await bal('cy'))===b0, `${b0} -> ${await bal('cy')}`); }

console.log('\n== criterion 13: 20 concurrent settlements over overlapping wallets ==');
{ await setup(); const s0=await st();
  const rs=await Promise.all(Array.from({length:20},(_,i)=>settle([Tr('rich','ada',100),Tr('ada','bob',50),Tr('bob','cy',25)])));
  const s1=await st(); const sum=s1.users.reduce((a,u)=>a+u.balance,0);
  const codes=rs.map(r=>r.status);
  ok(13,`20 concurrent settlements: total conserved, nothing negative, no 5xx (statuses ${[...new Set(codes)].join(',')})`,
     sum===s1.seeded_total && s1.users.every(u=>u.balance>=0) && !codes.some(c=>c>=500),
     `sum ${sum} vs seeded ${s1.seeded_total}; negatives ${JSON.stringify(s1.users.filter(u=>u.balance<0).map(u=>u.handle))}`); }

console.log('\n== criterion 14 (D61b): settlement membership survives export/import ==');
{ await setup();
  const sres=await settle([Tr('ada','bob',40,{visibility:'public'}),Tr('rich','cy',50,{visibility:'private'})]);
  const skey=K();
  const keyed=await settle([Tr('ada','cy',11)],T.op,skey);
  const ordinary=await rq(A,'POST','/payments',{body:{to_handle:'bob',amount:3},headers:{...AU(T.ada),'Idempotency-Key':K()}});
  const dump=await rq(A,'GET','/_test/export');
  const imp=await rq(Bb,'POST','/_test/import',{body:dump.json});
  ok(14,'export with a committed settlement imports into B -> 204', imp.status===204, `${imp.status} ${imp.text.slice(0,140)}`);
  const sB=await st(Bb);
  const members=sB.payments.filter(p=>p.settlement_id===sres.json.settlement_id);
  ok('14b','every member payment still carries its settlement_id on B', members.length===2, `${members.length} of 2`);
  const nonMember=sB.payments.find(p=>p.id===ordinary.json.payment_id);
  ok('14c','a non-member still exposes settlement_id null on B', nonMember&&nonMember.settlement_id===null, JSON.stringify(nonMember&&nonMember.settlement_id));
  const stB=sB.settlements.find(x=>x.id===sres.json.settlement_id);
  ok('14d','the batch still resolves to its members on B', !!stB, JSON.stringify(sB.settlements.map(x=>x.id)));
  const opOnB=await rq(Bb,'POST','/settlements',{body:{transfers:[Tr('ada','bob',1)]},headers:{...AU(T.op),'Idempotency-Key':K()}});
  const nonOpOnB=await rq(Bb,'POST','/settlements',{body:{transfers:[Tr('ada','bob',1)]},headers:{...AU(T.ada),'Idempotency-Key':K()}});
  ok('14e','operator permission survives: the operator can still settle on B, a non-operator is still 403',
     opOnB.status===201&&nonOpOnB.status===403, `${opOnB.status}/${nonOpOnB.status}`);
  const c0=await bal('cy',Bb);
  const retry=await rq(Bb,'POST','/settlements',{body:{transfers:[Tr('ada','cy',11)]},headers:{...AU(T.op),'Idempotency-Key':skey}});
  ok('14f','§11\'s last sentence: a settlement replayed on B returns the original complete response and moves no money',
     retry.status===200&&retry.text===keyed.text&&(await bal('cy',Bb))===c0, `${retry.status} identical=${retry.text===keyed.text}`); }
console.log(`\n==== W10 PROBE: ${pass} pass, ${fail} fail ====`);
if(F.length){console.log('FINDINGS:');F.forEach((f,i)=>console.log(` ${i+1}. ${f}`));}
