/* Cashfra lock-screen test — the page cashfra.com actually opens on.
 *
 *   python3 dev-server.py 8123 &
 *   BASE=http://127.0.0.1:8123/ node test/landing.mjs
 *
 * Checks the desktop treatment holds AND that the approved phone layout is
 * untouched by it — the whole risk of a wide-screen pass.
 */
import { chromium, devices } from 'playwright';
import { stubFeed } from './stub-feed.mjs';
import { tmpdir } from 'os';
import { join } from 'path';
const BASE = process.env.BASE || 'http://127.0.0.1:8123/';
const SB = (process.env.SHOT_DIR || tmpdir()) + '/';
const ok=[],bad=[]; const check=(c,m)=>(c?ok:bad).push(m);
const b=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined});

// ── desktop ──────────────────────────────────────────────────────────────
const dctx=await b.newContext({viewport:{width:1440,height:900}});
await stubFeed(dctx);
const d=await dctx.newPage();
d.on('pageerror',e=>bad.push('pageerror: '+e.message));
await d.goto(BASE,{waitUntil:'load'});
await d.waitForSelector('#gate.on');

const scroll=await d.evaluate(()=>({body:getComputedStyle(document.body).overflow,
  scrollable:document.documentElement.scrollHeight>document.documentElement.clientHeight}));
check(scroll.body==='hidden'&&!scroll.scrollable,`no stray scrollbar behind the lock (overflow ${scroll.body})`);

const card=await d.evaluate(()=>{const g=getComputedStyle(document.querySelector('.gwrap'));
  return{bg:g.backgroundColor,radius:g.borderRadius,shadow:g.boxShadow!=='none'};});
check(card.bg!=='rgba(0, 0, 0, 0)'&&card.shadow,`the wrap becomes a real card on desktop (${card.bg})`);
check(await d.locator('#gHint').isVisible(),`and says how to use a keyboard: "${(await d.locator('#gHint').textContent()).trim()}"`);
await d.screenshot({path:join(SB,'cashfra-gate-desktop.png')});

// the whole point: typing the code must work
await d.keyboard.type('16200');
check((await d.$$eval('.gd.f',e=>e.length))===5,'typed digits fill the dots');
await d.keyboard.press('Backspace');
check((await d.$$eval('.gd.f',e=>e.length))===4,'Backspace deletes one');
await d.keyboard.type('07');
await d.waitForFunction(()=>!document.getElementById('gate').classList.contains('on'),null,{timeout:5000});
check(true,'the code can be entered entirely from the keyboard');
check(await d.evaluate(()=>getComputedStyle(document.body).overflow!=='hidden'),'and the page scrolls again once unlocked');
await d.screenshot({path:join(SB,'cashfra-app-desktop.png')});

// ── phone: nothing about the approved design may move ────────────────────
const mctx=await b.newContext({...devices['Pixel 7']});
await stubFeed(mctx);
const m=await mctx.newPage();
await m.goto(BASE,{waitUntil:'load'});
await m.waitForSelector('#gate.on');
const mob=await m.evaluate(()=>{const g=getComputedStyle(document.querySelector('.gwrap'));
  const k=document.querySelector('.gk').getBoundingClientRect();
  return{bg:g.backgroundColor,pad:g.padding,key:k.width,hint:getComputedStyle(document.getElementById('gHint')).display};});
check(mob.bg==='rgba(0, 0, 0, 0)'&&mob.pad==='0px',`phone keeps the approved bare layout (bg ${mob.bg}, padding ${mob.pad})`);
/* sub-pixel layout on a scaled device viewport, so allow a hair either way */
check(Math.abs(mob.key-70)<1.5,`keypad untouched at ${mob.key.toFixed(1)}px (css says 70)`);
check(mob.hint==='none','the keyboard hint stays off a phone');
for(const c of '162007') await m.click(`#gPad [data-k="${c}"]`);
await m.waitForFunction(()=>!document.getElementById('gate').classList.contains('on'),null,{timeout:5000});
check(true,'tapping the pad still unlocks');
await b.close();
console.log(ok.map(s=>'  PASS  '+s).join('\n'));
if(bad.length){console.log('\n'+bad.map(s=>'  FAIL  '+s).join('\n'));process.exit(1);}
console.log(`\n${ok.length} checks passed`);
