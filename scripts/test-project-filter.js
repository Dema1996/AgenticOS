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
    const title = await card.$eval('.card-title', el => el.textContent);
    console.log('Clicking project:', title);
    await card.click();
    await page.waitForTimeout(500);
    const [view, header, itemCount, resetVisible] = await page.evaluate(() => [
      document.querySelector('.view:not(.hidden)')?.id,
      document.querySelector('#view-todos .section-label')?.textContent,
      document.querySelectorAll('#all-todos-list .todo-list-item').length,
      document.getElementById('todos-reset-btn')?.style?.display !== 'none',
    ]);
    console.log('View:', view);
    console.log('Header:', header);
    console.log('Todo items shown:', itemCount);
    console.log('Reset button visible:', resetVisible);
  }
  await page.screenshot({ path: '/tmp/project-filter.png' });
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
