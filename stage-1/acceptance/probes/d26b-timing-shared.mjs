// D45 companion: the same 500 users all SHARING one password. Before D41 this
// shape was memoised to a single hash (~17 ms); after it, it costs the same as
// the distinct case. Run both -- the pair is what shows reset cost no longer
// depends on a fixture's password shape.
//
//   LBL=<commit> BASE_URL=http://127.0.0.1:PORT node .../d26b-timing-shared.mjs
const B=process.env.BASE_URL;
const users=Array.from({length:500},(_,i)=>({id:`u_${i+1}`,email:`s${i}@example.com`,password:'one shared passphrase',display_name:`U${i}`,handle:`s${i}`,balance:1}));
const body=JSON.stringify({currency:'EUR',minor_units:2,users,payments:[],requests:[]});
const t=[];
for(let k=0;k<5;k++){const t0=Date.now();
 const r=await fetch(B+'/_test/reset',{method:'POST',headers:{'Content-Type':'application/json'},body});
 t.push(Date.now()-t0); if(r.status!==204) console.log('  !! status',r.status);
 await new Promise(s=>setTimeout(s,400));}
t.sort((a,b)=>a-b);
console.log(`  ${process.env.LBL}: ${t.join(', ')} ms   min ${t[0]} / median ${t[2]} / max ${t[4]}`);
