import puppeteer from 'puppeteer-core';
const b = await puppeteer.connect({browserURL: 'http://localhost:9222', defaultViewport: null});
const pages = await b.pages();
const visible = pages.filter(p => {
  const url = p.url();
  return url.startsWith('http') && !url.includes('extension') && !url.includes('background') && !url.includes('embed') && !url.includes('RotateCookies') && !url.includes('offscreen');
});
const page = visible[1];
// Go to google.com first
await page.goto('https://www.google.com/', {waitUntil: 'domcontentloaded', timeout: 10000}).catch(() => {});
await new Promise(r => setTimeout(r, 2000));
// Find and use the search box
const searchInput = await page.$('textarea[name="q"]');
if (searchInput) {
  await searchInput.click();
  await searchInput.type('cnc machine', {delay: 50});
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 3000));
}
// Extract results
const results = await page.evaluate(() => {
  const items = [];
  document.querySelectorAll('#search .g').forEach(el => {
    const titleEl = el.querySelector('h3');
    const linkEl = el.querySelector('a');
    const snippetEl = el.querySelector('[style]') || el.querySelector('.VwiZ3b');
    if (titleEl && linkEl) {
      items.push({
        title: titleEl.textContent,
        url: linkEl.href,
        snippet: snippetEl ? snippetEl.textContent : ''
      });
    }
  });
  return items;
});
console.log(JSON.stringify(results, null, 2));
await b.disconnect();
