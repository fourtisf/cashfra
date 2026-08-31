/* The app opens on an empty ledger now, so a suite that needs entries asks for
   the sample set the same way a person would — through the UI, which also
   keeps that path under test. */
export async function loadSample(page) {
  await page.click('#moreBtn');
  await page.waitForSelector('#ovPanel.on', { timeout: 3000 });
  await page.click('#pBody .mi[data-panel="data"]');
  await page.waitForTimeout(250);
  await page.click('#pBody [data-seed]');
  await page.waitForTimeout(500);
  await page.click('#pClose');
  await page.waitForFunction(() => !document.getElementById('ovPanel').classList.contains('on'),
                             null, { timeout: 3000 });
  await page.waitForTimeout(200);
}

/* The dev server is not a sync server, so /sync 404s — and offline, it fails
   outright. That is the app correctly discovering there is nothing there
   (once, then it stops), not a defect for a suite to report. */
export const syncNoise = u => /\/sync(\?|$)/.test(String(u || ''));
export const consoleNoise = m => {
  try { return syncNoise(m.location() && m.location().url); } catch (e) { return false; }
};
