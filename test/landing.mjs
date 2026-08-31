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
import { consoleNoise, syncNoise } from './helpers.mjs';
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
  return{img:g.backgroundImage,shadow:g.boxShadow};});
/* a lit object, not a flat panel: a gradient face and an inset top highlight */
check(card.img!=='none'&&/inset/.test(card.shadow),'the wrap is a lit card on desktop');
check(await d.locator('#gHint').isVisible(),`and says how to use a keyboard: "${(await d.locator('#gHint').textContent()).trim()}"`);
check(await d.locator('.gtag').isVisible(),`the wordmark carries its descriptor: "${(await d.locator('.gtag').textContent()).trim()}"`);
/* the spacer key sits under 0 — any decoration added to .gk must not reach it */
const ghost=await d.evaluate(()=>{const g=getComputedStyle(document.querySelector('.gk.ghost'));
  return{border:g.borderTopWidth,shadow:g.boxShadow,bg:g.backgroundColor};});
check(ghost.border==='0px'&&ghost.shadow==='none'&&ghost.bg==='rgba(0, 0, 0, 0)',
      `the keypad spacer stays invisible (border ${ghost.border}, shadow ${ghost.shadow})`);
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

// ── motion is an enhancement, never a requirement ────────────────────────
const rctx = await b.newContext({ viewport:{width:1440,height:900}, reducedMotion:'reduce' });
await stubFeed(rctx);
const r = await rctx.newPage();
await r.goto(BASE,{waitUntil:'load'});
await r.waitForSelector('#gate.on');
const anim = await r.evaluate(()=>[...document.querySelectorAll('.gwrap,.glogo,.gpad')]
  .map(e=>getComputedStyle(e).animationName));
check(anim.every(a=>a==='none'), `reduced motion turns the entrance off (${anim.join(',')})`);
check(await r.locator('.gwrap').isVisible(), 'and the card is still there, not stuck invisible');
await rctx.close();

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
/* iOS read two quick taps on the keypad as double-tap-to-zoom, which is what
   entering a six-digit code at normal speed looks like */
const touch=await m.evaluate(()=>{
  const of=s=>getComputedStyle(document.querySelector(s)).touchAction;
  return{key:of('.gk'),add:of('#addBtn2'),more:of('#moreBtn'),gate:getComputedStyle(document.getElementById('gate')).overscrollBehaviorY};});
check(touch.key==='manipulation'&&touch.add==='manipulation'&&touch.more==='manipulation',
      `tapping fast cannot zoom the page (keypad ${touch.key}, buttons ${touch.add})`);
check(touch.gate==='contain','and the lock screen does not rubber-band the page behind it');
for(const c of '162007') await m.click(`#gPad [data-k="${c}"]`);
await m.waitForFunction(()=>!document.getElementById('gate').classList.contains('on'),null,{timeout:5000});
check(true,'tapping the pad still unlocks');

// ── the notch and the home indicator ─────────────────────────────────────
/* Installed to the home screen there is no browser chrome, so the page starts
   under the clock and the battery. ALFA's header collided with both, and the
   toast landed inside the button bar rather than above it. Neither shows in a
   desktop browser, where the insets are zero — so the app reads them through
   --sat/--sab and this pretends to be a phone that has them. */
/* the lock screen is a full-bleed overlay of its own, and ignored the insets
   entirely — the logo ran into the notch and the footer sat on the home bar */
await m.evaluate(() => {
  document.documentElement.style.setProperty('--sat', '47px');
  document.documentElement.style.setProperty('--sab', '34px');
  document.getElementById('gate').classList.add('on');
});
await m.waitForTimeout(150);
const gate = await m.evaluate(() => {
  const g = document.getElementById('gate').getBoundingClientRect();
  const logo = document.querySelector('.glogo').getBoundingClientRect();
  const note = document.querySelector('.gnote').getBoundingClientRect();
  return { logoTop: logo.top, noteBottom: note.bottom, h: window.innerHeight, gh: g.height };
});
check(gate.logoTop >= 47, `the lock screen keeps its logo below the notch (${Math.round(gate.logoTop)}px)`);
check(gate.h - gate.noteBottom >= 34,
      `and its footer above the home bar (${Math.round(gate.h - gate.noteBottom)}px)`);
await m.evaluate(() => {
  document.getElementById('gate').classList.remove('on');
  document.documentElement.style.removeProperty('--sat');
  document.documentElement.style.removeProperty('--sab');
});
await m.waitForTimeout(120);

const flat = await m.locator('.hd').evaluate(e => e.getBoundingClientRect().top);
await m.evaluate(() => {
  document.documentElement.style.setProperty('--sat', '47px');   // a notch
  document.documentElement.style.setProperty('--sab', '34px');   // a home bar
});
await m.waitForTimeout(150);
const notched = await m.locator('.hd').evaluate(e => e.getBoundingClientRect().top);
check(notched - flat === 47,
      `the header moves clear of the status bar on a notched phone (${flat} -> ${notched})`);

/* the toast lives inside the app's closure; its position is pure CSS, so
   showing the element is enough to measure where it lands */
await m.evaluate(() => {
  const t = document.getElementById('toast');
  document.getElementById('tMsg').textContent = 'Entry updated';
  t.classList.add('on');
});
await m.waitForTimeout(350);
const box = await m.evaluate(() => {
  const t = document.getElementById('toast').getBoundingClientRect();
  const btn = document.getElementById('addBtn2').getBoundingClientRect();
  return { toastBottom: t.bottom, btnTop: btn.top, btnBottom: btn.bottom, h: window.innerHeight };
});
check(box.toastBottom <= box.btnTop + 1,
      `the toast sits above the button, not on it (ends ${Math.round(box.toastBottom)}, button starts ${Math.round(box.btnTop)})`);
check(box.h - box.btnBottom >= 34,
      `and the button clears the home indicator (${Math.round(box.h - box.btnBottom)}px below it)`);

/* a full-height sheet starts just below where a notch ends; "just below" is
   not clearance, and its close button is the first thing a thumb reaches for */
await m.evaluate(() => {
  document.documentElement.style.setProperty('--sat', '47px');
  document.documentElement.style.setProperty('--sab', '34px');
});
await m.click('#moreBtn');
await m.waitForSelector('#ovPanel.on', { timeout: 3000 });
await m.waitForTimeout(300);
const sheet = await m.evaluate(() => {
  const s = document.querySelector('#ovPanel .sheet').getBoundingClientRect();
  const x = document.getElementById('pX').getBoundingClientRect();
  return { top: s.top, xTop: x.top };
});
check(sheet.top >= 47 && sheet.xTop >= 47,
      `a full-height sheet and its close button stay under the notch (${Math.round(sheet.top)}, ${Math.round(sheet.xTop)})`);
await m.click('#pClose');
await m.waitForTimeout(300);

const clear = await m.evaluate(async () => {
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise(r => setTimeout(r, 200));
  const last = document.querySelector('#list .tot') || document.querySelector('#list .zero');
  const bar = document.querySelector('.stick').getBoundingClientRect();
  return last.getBoundingClientRect().bottom <= bar.top + 1;
});
check(clear, 'and the end of the list is not left behind the bar');

await b.close();
console.log(ok.map(s=>'  PASS  '+s).join('\n'));
if(bad.length){console.log('\n'+bad.map(s=>'  FAIL  '+s).join('\n'));process.exit(1);}
console.log(`\n${ok.length} checks passed`);
