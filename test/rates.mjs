/* Cashfra price-feed test — the live rate updates, against stubbed feeds.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/rates.mjs
 *
 * The check that matters most is the one proving a price update never
 * revalues an entry that is already in the books.
 *
 * The rest is about the price the form offers being the price now. A deal is
 * agreed in coin and booked in dollars, so a prefill nobody can date is worse
 * than no prefill at all — every section below was written against a way the
 * old build got that wrong quietly: a coin the feed skipped, a feed that
 * refused, a request that never came back, and a coin chip that never asked.
 *
 * Runs about a minute: some of it is real waiting, because a backoff and a
 * request deadline are only worth anything in wall-clock time. */
import { chromium, devices } from 'playwright';
import { stubFeed, feedHits, feedUrls, feedDown, feedHang, standby } from './stub-feed.mjs';
import { consoleNoise, syncNoise } from './helpers.mjs';
const BASE = process.env.BASE || 'http://127.0.0.1:8123/';
const ok=[],bad=[]; const check=(c,m)=>(c?ok:bad).push(m);
const b=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});
const ctx=await b.newContext({...devices['Pixel 7']});
const p=await ctx.newPage();
p.on('pageerror',e=>bad.push('pageerror: '+e.message));

await stubFeed(ctx,{
  solana:{usd:243.17,idr:3900000}, binancecoin:{usd:1104.8,idr:1.7e7},
  ethereum:{usd:4210.55,idr:6.8e7}, tron:{usd:0.31284,idr:5100},
  tether:{usd:0.9997,idr:16842}, 'usd-coin':{usd:1.0003,idr:16845}});
let hits=0, lastUrl='';
const sync=async()=>{hits=await feedHits(p);var u=await feedUrls(p);lastUrl=u[u.length-1]||'';};

await p.goto(BASE,{waitUntil:'load'});
await p.waitForSelector('#gate.on');
for(const d of '162007') await p.click(`#gPad [data-k="${d}"]`);
await p.waitForFunction(()=>!document.getElementById('gate').classList.contains('on'));
const before = await p.evaluate(()=>JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.map(t=>({id:t.id,rate:t.rate,usd:t.usd})));
await p.waitForTimeout(1200);

await sync();
const S = await p.evaluate(()=>JSON.parse(localStorage.getItem('fourtis:ledger:v3')));
const rates = Object.fromEntries(S.rates);
check(hits===1, `feed called once on unlock (${hits})`);
check(/ids=solana,binancecoin,ethereum,tron,tether,usd-coin/.test(lastUrl), `asks only for the coins in the rate list`);
check(rates.SOL===243.17 && rates.BNB===1104.8 && rates.ETH===4210.55, `live prices applied: SOL ${rates.SOL} BNB ${rates.BNB} ETH ${rates.ETH}`);
check(rates.TRX===0.3128, `sub-$1 keeps precision: TRX ${rates.TRX}`);
check(rates.USDT===1 && rates.USDC===1, `stablecoin wobble pinned to 1: USDT ${rates.USDT} USDC ${rates.USDC}`);
check(S.idr===16842, `USD→IDR updated: ${S.idr}`);
check(S.rateAt>0, 'last-checked stamp written');

// ── THE rule: old entries must never be revalued ────────────────────────
const after = await p.evaluate(()=>JSON.parse(localStorage.getItem('fourtis:ledger:v3')).tx.map(t=>({id:t.id,rate:t.rate,usd:t.usd})));
check(JSON.stringify(before)===JSON.stringify(after), `existing entries keep their locked rate + USD (${after.length} entries untouched)`);

// ── a new entry prefills from the fresh price ───────────────────────────
await p.click('#addBtn2'); await p.waitForSelector('#ovForm.on');
await p.waitForTimeout(300);
check(await p.inputValue('#fRate')==='243.17', `new entry prefills the live SOL price: ${await p.inputValue('#fRate')}`);
await p.click('#fX'); await p.waitForTimeout(200);

// ── throttle: reopening does not hammer the feed ────────────────────────
await p.click('#addBtn2'); await p.waitForSelector('#ovForm.on'); await p.waitForTimeout(400);
await sync();
check(hits===1, `throttled — still ${hits} call after reopening the form`);
await p.click('#fX'); await p.waitForTimeout(200);

// ── Settings: stamp, manual refresh, and the off switch ─────────────────
await p.click('#moreBtn'); await p.waitForSelector('#ovPanel.on');
await p.click('#pBody .mi[data-panel="set"]'); await p.waitForTimeout(300);
const setTxt = await p.locator('#pBody').innerText();
check(/Update prices automatically/.test(setTxt) && /Checked just now/.test(setTxt), `settings shows the stamp: ${(setTxt.match(/Checked [^\n]*/)||[''])[0]}`);
await p.click('#pBody [data-rate="now"]'); await p.waitForTimeout(700);
await sync();
check(hits===2, `"Refresh prices now" forces a call past the throttle (${hits})`);

await p.click('#pBody label.sw:has(#pAuto) i'); await p.waitForTimeout(700);
check(await p.evaluate(()=>JSON.parse(localStorage.getItem('fourtis:ledger:v3')).rateAuto)===false, 'switch off is persisted');
const offTxt = await p.locator('#pBody').innerText();
check(/stay exactly as you set them/.test(offTxt), 'settings explains what off means');
await sync();
const hitsAtOff = hits;
await p.click('#pClose'); await p.waitForTimeout(200);
await p.click('#addBtn2'); await p.waitForSelector('#ovForm.on'); await p.waitForTimeout(500);
await sync();
check(hits===hitsAtOff, `off means off — no call when the form opens (${hits} vs ${hitsAtOff})`);

// ── a coin the round skipped is not passed off as checked ───────────────
/* What a rate-limited or half-broken feed really looks like is not a clean
   failure — it is an answer with coins missing from it. One timestamp for
   every coin turned that into "checked just now" for a price nobody had. */
const ctx2=await b.newContext({...devices['Pixel 7']});
await stubFeed(ctx2,{solana:{usd:243.17,idr:3900000}, tether:{usd:1,idr:16842}});
const p2=await ctx2.newPage();
p2.on('pageerror',e=>bad.push('pageerror(partial): '+e.message));
await p2.goto(BASE,{waitUntil:'load'});
await p2.waitForSelector('#gate.on');
for(const d of '162007') await p2.click(`#gPad [data-k="${d}"]`);
await p2.waitForFunction(()=>!document.getElementById('gate').classList.contains('on'));
await p2.waitForTimeout(1500);
const S2=await p2.evaluate(()=>JSON.parse(localStorage.getItem('fourtis:ledger:v3')));
const st2=S2.rateEach||{};
check(st2.SOL>0&&!st2.ETH, `only the coins that answered are stamped (SOL ${!!st2.SOL}, ETH ${!!st2.ETH})`);
check(Object.fromEntries(S2.rates).ETH===3000, 'a coin the feed skipped keeps the number it had');
await p2.click('#addBtn2'); await p2.waitForSelector('#ovForm.on'); await p2.waitForTimeout(300);
const liveHint=(await p2.locator('#rateHint').textContent()).trim();
check(/Live SOL price/.test(liveHint), `a price that is live says so: "${liveHint}"`);
await p2.click('#toks [data-tok="ETH"]'); await p2.waitForTimeout(300);
const ethHint=(await p2.locator('#rateHint').textContent()).trim();
check(await p2.locator('#rateHint').isVisible()&&/No live ETH price yet/.test(ethHint),
      `the coin the feed skipped is called out, not shown as a quote: "${ethHint}"`);
await ctx2.close();

// ── the standby feed carries it when the first one refuses ──────────────
const ctx3=await b.newContext({...devices['Pixel 7']});
await stubFeed(ctx3);
const p3=await ctx3.newPage();
p3.on('pageerror',e=>bad.push('pageerror(standby): '+e.message));
await p3.goto(BASE,{waitUntil:'load'});
await p3.waitForSelector('#gate.on');
for(const d of '162007') await p3.click(`#gPad [data-k="${d}"]`);
await p3.waitForFunction(()=>!document.getElementById('gate').classList.contains('on'));
await p3.waitForTimeout(900);
await feedDown(p3,true);
await standby(p3,{SOL:250.5,BNB:1000.25,ETH:4500.5,TRX:0.3,USDT:1,USDC:1,IDR:16900});
await p3.click('#moreBtn'); await p3.waitForSelector('#ovPanel.on');
await p3.click('#pBody .mi[data-panel="set"]'); await p3.waitForTimeout(300);
await p3.click('#pBody [data-rate="now"]'); await p3.waitForTimeout(1500);
const S3=await p3.evaluate(()=>JSON.parse(localStorage.getItem('fourtis:ledger:v3')));
const r3=Object.fromEntries(S3.rates);
check(r3.ETH===4500.5&&r3.SOL===250.5, `first feed refusing does not stop the prices: ETH ${r3.ETH} SOL ${r3.SOL}`);
check(S3.idr===16900, `the IDR rate comes from the standby too: ${S3.idr}`);
check(/Coinbase/.test(await p3.locator('#pBody').innerText()), 'settings names the feed that answered');

// ── a request that never comes back must not freeze every price ─────────
/* fetch() has no deadline of its own. One request left hanging used to leave
   the in-flight flag set for the life of the page, and no price on the device
   ever moved again. */
await feedHang(p3,true); await standby(p3,null);
await p3.click('#pBody [data-rate="now"]'); await p3.waitForTimeout(9500);
check(/could not|not answering|failed/i.test(await p3.locator('#pBody').innerText()),
      'a hung request is given up on and said out loud');
await feedHang(p3,false); await standby(p3,{SOL:260,BNB:1010,ETH:4600,TRX:0.31,USDT:1,USDC:1,IDR:16950});
await p3.click('#pBody [data-rate="now"]'); await p3.waitForTimeout(1500);
const r3b=Object.fromEntries((await p3.evaluate(()=>JSON.parse(localStorage.getItem('fourtis:ledger:v3')))).rates);
check(r3b.ETH===4600, `prices still move after a hung request: ETH ${r3b.ETH}`);
await ctx3.close();

// ── the rest after a failure, and the coin chip asking for itself ───────
const ctx4=await b.newContext({...devices['Pixel 7']});
await stubFeed(ctx4,{solana:{usd:200,idr:3.2e6}, binancecoin:{usd:900,idr:1.4e7},
  ethereum:{usd:4321.5,idr:7e7}, tron:{usd:0.3,idr:4900},
  tether:{usd:1,idr:16500}, 'usd-coin':{usd:1,idr:16500}});
const p4=await ctx4.newPage();
p4.on('pageerror',e=>bad.push('pageerror(backoff): '+e.message));
await p4.goto(BASE,{waitUntil:'load'});
await feedDown(p4,true);                       /* the flag survives the reload */
await p4.reload({waitUntil:'load'});
await p4.waitForSelector('#gate.on');
for(const d of '162007') await p4.click(`#gPad [data-k="${d}"]`);
await p4.waitForFunction(()=>!document.getElementById('gate').classList.contains('on'));
await p4.waitForTimeout(900);
check((await p4.evaluate(()=>JSON.parse(localStorage.getItem('fourtis:ledger:v3')).rateAt))===0,
      'a round that failed leaves no last-checked stamp behind');
await p4.click('#addBtn2'); await p4.waitForSelector('#ovForm.on'); await p4.waitForTimeout(500);
check(await feedHits(p4)===1, `a feed that just refused is rested, not hammered (${await feedHits(p4)} call)`);
const downHint=(await p4.locator('#rateHint').textContent()).trim();
check(/No live SOL price yet/.test(downHint), `and the form says the number is only a starting value: "${downHint}"`);
await feedDown(p4,false);
await p4.waitForTimeout(11000);                /* the first rest is ten seconds */
await p4.click('#toks [data-tok="ETH"]'); await p4.waitForTimeout(1200);
check(await feedHits(p4)===2, `switching the coin asks again once the rest is over (${await feedHits(p4)} calls)`);
check(await p4.inputValue('#fRate')==='4321.5', `and the live price for that coin lands in the box: ${await p4.inputValue('#fRate')}`);
check(/Live ETH price/.test((await p4.locator('#rateHint').textContent()).trim()), 'the hint turns live with it');
await ctx4.close();

await b.close();
console.log(ok.map(s=>'  PASS  '+s).join('\n'));
if(bad.length){console.log('\n'+bad.map(s=>'  FAIL  '+s).join('\n'));process.exit(1);}
console.log(`\n${ok.length} checks passed`);
