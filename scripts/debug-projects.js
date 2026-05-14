#!/usr/bin/env node
const { chromium } = require('../node_modules/playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:4000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const result = await page.evaluate(() => {
    const cards = document.querySelectorAll('#projects-grid .project-card');
    if (!cards.length) return { count: 0 };
    const card = cards[0];
    const rect = card.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const topEl = document.elementFromPoint(cx, cy);
    return {
      count: cards.length,
      cardRect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      topElement: topEl ? topEl.tagName + '#' + topEl.id + '.' + [...topEl.classList].join('.') : 'none',
      topParents: topEl ? (() => {
        const chain = [];
        let el = topEl;
        for (let i = 0; i < 5 && el; i++, el = el.parentElement)
          chain.push(el.tagName + (el.id ? '#'+el.id : '') + (el.className ? '.'+[...el.classList].join('.') : ''));
        return chain;
      })() : [],
    };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
