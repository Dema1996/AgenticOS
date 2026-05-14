#!/usr/bin/env node
const { chromium } = require('../node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const logs = [];
  page.on('console', m => logs.push(m.text()));
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Try clicking the "Projekte" nav link
  const navLink = await page.$('[data-view="projects"]');
  if (navLink) {
    const box = await navLink.boundingBox();
    console.log('Projekte nav box:', JSON.stringify(box));
    await navLink.click();
    await page.waitForTimeout(500);
    const activeView = await page.evaluate(() => {
      const v = document.querySelector('.view:not(.hidden)');
      return v ? v.id : 'none';
    });
    console.log('Active view after click:', activeView);
  } else {
    console.log('Nav link not found!');
  }

  // Check if project cards have onclick
  const cardOnclick = await page.evaluate(() => {
    const cards = document.querySelectorAll('.project-card');
    return cards.length + ' cards, first onclick: ' + (cards[0]?.getAttribute('onclick') || 'none');
  });
  console.log('Project cards:', cardOnclick);

  // Check what element is on top at project card position
  const firstCard = await page.$('.project-card');
  if (firstCard) {
    const box = await firstCard.boundingBox();
    const topEl = await page.evaluate(({x, y}) => {
      const el = document.elementFromPoint(x, y);
      return el ? el.tagName + '.' + el.className.substring(0,40) : 'none';
    }, { x: box.x + box.width/2, y: box.y + box.height/2 });
    console.log('Element on top of project card center:', topEl);
  }

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
