#!/usr/bin/env node
const { chromium } = require('../node_modules/playwright');
const out = process.argv[2] || '/tmp/content.png';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const el = await page.$('#content');
  if (el) await el.screenshot({ path: out });
  await browser.close();
  console.log('->', out);
})().catch(e => { console.error(e.message); process.exit(1); });
