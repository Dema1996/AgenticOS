#!/usr/bin/env node
const { chromium } = require('../node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const result = await page.evaluate(() => ({
    marked:   typeof marked,
    hljs:     typeof hljs,
    Sortable: typeof Sortable,
    lucide:   typeof lucide,
    mdTest:   typeof marked !== 'undefined' ? marked.parse('**bold**') : 'N/A',
  }));
  console.log('Library status:', JSON.stringify(result, null, 2));
  console.log('Console errors:', errors.slice(0,5));
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
