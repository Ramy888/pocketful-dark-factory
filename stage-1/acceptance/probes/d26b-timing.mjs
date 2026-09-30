// D26b/D45: 500 seeded users with 500 DISTINCT passwords through the real
// POST /_test/reset. Five runs, min/median/max. Report host conditions with the
// number -- a single figure is wrong in both directions (see D45).
//
//   LBL=<commit> BASE_URL=http://127.0.0.1:PORT node .../d26b-timing.mjs
const B=process.env.BASE_URL;
const users=Array.from({length:500},(_,i)=>({id:`u_${i+1}`,email:`d${i}@example.com`,password:`distinct-pw-${i}-${'y'.repeat(i%13)}`,display_name:`U${i}`,handle:`d${i}`,balance:1}));
const body=JSON.stringify({currency:'EUR',minor_units:2,users,payments:[],requests:[]});
const t=[];
for(let k=0;k<5;k++){const t0=Date.now();
 const r=await fetch(B+'/_test/reset',{method:'POST',headers:{'Content-Type':'application/json'},body});
 t.push(Date.now()-t0); if(r.status!==204) console.log('  !! status',r.status);
 await new Promise(s=>setTimeout(s,400));}
t.sort((a,b)=>a-b);
console.log(`  ${process.env.LBL}: ${t.join(', ')} ms   median ${t[2]} ms`);
