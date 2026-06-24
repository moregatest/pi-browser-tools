#!/usr/bin/env node
// Screenshot a URL — viewport, full page, a single element, or mobile-emulated.
// Launches its own headless Chromium (no :9222 needed). Prints JSON to stdout.
//
// Usage: browser-capture.js <url> [options]
//
// Options:
//   --full-page                capture the full scrollable page
//   --selector=<css>           screenshot one matching element
//   --device="iPhone 15"       emulate a known device (overrides --viewport)
//   --viewport=WxH             viewport size (default 1440x900)
//   --out=<file>               output path (default /tmp/capture.png)
//   --zyte                     route via Zyte Smart Proxy (opt-in; needs ZYTE_API_KEY in env)
//   --zyte-spm-profile=<p>     SPM profile override: desktop|mobile|pass (default: auto from --device)
import puppeteer, { KnownDevices } from 'puppeteer';
import { launchZyte, newPageZyte, zyteLabel } from './zyte-proxy.js';
import fs from 'node:fs';
const a = (n, d) => { const h = process.argv.find(x => x.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const flag = n => process.argv.includes(`--${n}`);

(async () => {
  const url = process.argv[2];
  const out = a('out', '/tmp/capture.png');
  const device = a('device', '');
  const selector = a('selector', '');
  const fullPage = flag('full-page');
  // Pass device name to launchZyte for auto SPM profile detection
  const { browser, zyte } = await launchZyte(puppeteer, { headless: true, args: ['--no-sandbox'] }, process.argv, device);
  const page = await newPageZyte(browser, zyte);
  if (device && KnownDevices && KnownDevices[device]) {
    await page.emulate(KnownDevices[device]);
  } else {
    const [w, h] = (a('viewport', '1440x900')).split('x').map(Number);
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  }
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 800));

  const observed = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent, touch: navigator.maxTouchPoints, scrollH: document.body.scrollHeight }));
  if (selector) {
    const el = await page.$(selector);
    if (!el) { console.error('ERR selector not found: ' + selector); process.exit(2); }
    await el.screenshot({ path: out });
  } else {
    await page.screenshot({ path: out, fullPage });
  }
  console.log(JSON.stringify({ out, bytes: fs.statSync(out).size, mode: selector ? 'element' : (fullPage ? 'full-page' : 'viewport'), device: device || null, proxy: zyteLabel(zyte), observed }, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
