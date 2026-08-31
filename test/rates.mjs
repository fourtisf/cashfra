/* Cashfra price-feed test — the live rate updates, against a stubbed feed.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/rates.mjs
 *
 * The check that matters most is the one proving a price update never
 * revalues an entry that is already in the books. */
import { chromium, devices } from 'playwright';
import { stubFeed, feedHits, feedUrls } from './stub-feed.mjs';
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

await b.close();
console.log(ok.map(s=>'  PASS  '+s).join('\n'));
if(bad.length){console.log('\n'+bad.map(s=>'  FAIL  '+s).join('\n'));process.exit(1);}
console.log(`\n${ok.length} checks passed`);
