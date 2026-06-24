#!/usr/bin/env node
// Capture all network responses for a URL and (optionally) filter by HTTP status.
// Launches its own headless Chromium. Prints JSON to stdout.
//
// Usage: browser-netlog.js <url> [options]
//
// Options:
//   --min-status=400           only report responses with status >= N (default 0 = all)
//   --device="iPhone 15"       emulate a known device (overrides --viewport)
//   --viewport=WxH             viewport size (default 1440x900)
//   --zyte                     route via Zyte Smart Proxy (opt-in; needs ZYTE_API_KEY in env)
//   --zyte-spm-profile=<p>     SPM profile override: desktop|mobile|pass (default: auto from --device)
import puppeteer, { KnownDevices } from 'puppeteer';
import { launchZyte, newPageZyte, zyteLabel } from './zyte-proxy.js';
const a = (n, d) => { const h = process.argv.find(x => x.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

(async () => {
  const url = process.argv[2];
  const minStatus = parseInt(a('min-status', '0'), 10);
  const device = a('device', '');
  const { browser, zyte } = await launchZyte(puppeteer, { headless: true, args: ['--no-sandbox'] }, process.argv, device);
  const page = await newPageZyte(browser, zyte);
  if (device && KnownDevices && KnownDevices[device]) await page.emulate(KnownDevices[device]);
  else { const [w, h] = (a('viewport', '1440x900')).split('x').map(Number); await page.setViewport({ width: w, height: h }); }

  const entries = [];
  page.on('response', r => entries.push({ status: r.status(), type: r.request().resourceType(), url: r.url() }));
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 800));

  const filtered = entries.filter(e => e.status >= minStatus);
  const byStatus = {};
  for (const e of entries) { const b = Math.floor(e.status / 100) + 'xx'; byStatus[b] = (byStatus[b] || 0) + 1; }
  console.log(JSON.stringify({
    url, proxy: zyteLabel(zyte), total: entries.length, minStatus, matched: filtered.length, byStatus,
    requests: filtered.sort((x, y) => y.status - x.status),
  }, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
