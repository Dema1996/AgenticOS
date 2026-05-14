#!/usr/bin/env node
const { chromium } = require('../node_modules/playwright');
const out = process.argv[2] || '/tmp/todos.png';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  // Navigate to todos view
  await page.click('[data-view="todos"]');
  await page.waitForTimeout(600);
  // Select a project in the dropdown
  await page.selectOption('#todos-filter', { index: 1 });
  await page.waitForTimeout(400);
  const el = await page.$('#view-todos');
  if (el) await el.screenshot({ path: out });
  await browser.close();
  console.log('->', out);
})().catch(e => { console.error(e.message); process.exit(1); });
