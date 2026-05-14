#!/usr/bin/env node
const { chromium } = require('../node_modules/playwright');
const path = require('path');
const out = process.argv[2] || path.join(__dirname, '../.screenshots/task.png');
const fs = require('fs');
fs.mkdirSync(path.dirname(out), { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const task = await page.$('.recent-task-item');
  if (task) {
    await task.click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: out });
  await browser.close();
  console.log('Screenshot ->', out);
})().catch(e => { console.error(e.message); process.exit(1); });
