#!/usr/bin/env node
const { chromium } = require('../node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const card = await page.$('#projects-grid .project-card');
  if (card) {
    await card.click();
    await page.waitForTimeout(600);
    const [view, inputVal] = await page.evaluate(() => [
      document.querySelector('.view:not(.hidden)')?.id,
      document.getElementById('task-input')?.value,
    ]);
    console.log('View after click:', view);
    console.log('Task input:', inputVal?.substring(0, 80));
  }
  await page.screenshot({ path: '/tmp/project-click.png' });
  await browser.close();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
