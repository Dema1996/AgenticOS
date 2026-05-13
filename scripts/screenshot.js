#!/usr/bin/env node
// Usage: node scripts/screenshot.js [output-path] [url]
const { chromium } = require('../node_modules/playwright');
const path = require('path');

const outPath = process.argv[2] || path.join(__dirname, '../.screenshots/latest.png');
const url     = process.argv[3] || 'http://localhost:4000';
const fs = require('fs');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: outPath, fullPage: false });
  await browser.close();
  console.log(`Screenshot → ${outPath}`);
})().catch(e => { console.error(e.message); process.exit(1); });
