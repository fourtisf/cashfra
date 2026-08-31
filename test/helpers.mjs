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
