#!/usr/bin/env node
// Grab a form's verification (CAPTCHA) image — including ones rendered inside an iframe.
// CAPTCHA images are session-bound and usually REGENERATE on every request, so re-downloading
// the URL gives a different code than the one on screen. This captures the EXACTLY-DISPLAYED
// response bytes via interception (falls back to an element screenshot). Prints JSON to stdout.
//
// Usage: browser-captcha.js <url> [--out=/tmp/captcha.png] [--match=<regex>]
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const a = (n, d) => { const h = process.argv.find(x => x.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const DEFAULT_RE = 'captcha|verif|seccode|vcode|checkcode|authcode|securimage|kcaptcha|getcode|imgcode|valicode|randcode';

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('usage: browser-captcha.js <url> [--out=file] [--match=regex]'); process.exit(2); }
  let out = a('out', '/tmp/captcha.png');
  const reSrc = a('match', '') || DEFAULT_RE;
  const matchRe = new RegExp(reSrc, 'i');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1400, deviceScaleFactor: 1 });

  const bufs = new Map(); // response url -> { buf, ct }
  page.on('response', async r => {
    const u = r.url(), ct = r.headers()['content-type'] || '';
    const dyn = /\.(php|asp|aspx|jsp|cgi|ashx)(\?|$)/i.test(u);
    if (matchRe.test(u) || (dyn && /image/i.test(ct))) { try { bufs.set(u, { buf: await r.buffer(), ct }); } catch (e) {} }
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  const findIn = (frame) => frame.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const abs = u => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
    const imgs = [...document.querySelectorAll('img')];
    let im = imgs.find(x => re.test(x.getAttribute('src') || '') || re.test(x.id || '') || re.test(String(x.className)));
    if (!im) im = imgs.find(x => /\.(php|asp|aspx|jsp|cgi|ashx)(\?|$)/i.test(x.getAttribute('src') || '') && x.naturalWidth > 30 && x.naturalWidth < 320 && x.naturalHeight < 120);
    if (!im) return null;
    const r = im.getBoundingClientRect();
    const field = [...document.querySelectorAll('input[type=text],input:not([type])')].find(i => /captcha|code|verif|valid|chk/i.test((i.name || '') + (i.id || '')));
    const form = document.querySelector('form');
    return { src: abs(im.getAttribute('src')), naturalW: im.naturalWidth, naturalH: im.naturalHeight, dispW: Math.round(r.width), dispH: Math.round(r.height), id: im.id || '', inputField: field ? (field.name || field.id) : null, formAction: form ? abs(form.getAttribute('action')) : null };
  }, reSrc).catch(() => null);

  let hit = await findIn(page.mainFrame()), frameUrl = null, inIframe = false;
  if (!hit) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const r = await findIn(f);
      if (r) { hit = r; frameUrl = f.url(); inIframe = true; break; }
    }
  }

  const result = { url, found: !!hit, out: null };
  if (hit) {
    result.captcha = { endpoint: hit.src, naturalSize: hit.naturalW + 'x' + hit.naturalH, displaySize: hit.dispW + 'x' + hit.dispH, imgId: hit.id || null, inputField: hit.inputField, inIframe, frameUrl, formAction: hit.formAction };
    let rec = bufs.get(hit.src) || [...bufs.values()].pop();
    if (rec && rec.buf && rec.buf.length > 400) {
      if (/jpe?g/i.test(rec.ct) && !/\.(jpg|jpeg)$/i.test(out)) out = out.replace(/\.\w+$/, '') + '.jpg';
      else if (/gif/i.test(rec.ct) && !/\.gif$/i.test(out)) out = out.replace(/\.\w+$/, '') + '.gif';
      fs.writeFileSync(out, rec.buf);
      Object.assign(result, { out, bytes: rec.buf.length, method: 'intercepted-response', contentType: rec.ct });
    } else {
      const frame = inIframe ? page.frames().find(f => f.url() === frameUrl) : page.mainFrame();
      let el = hit.id ? await frame.$('#' + hit.id).catch(() => null) : null;
      if (!el) el = await frame.$('img[src*="captcha"]').catch(() => null);
      if (el) { await el.evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {}); await new Promise(r => setTimeout(r, 300)); await el.screenshot({ path: out }); Object.assign(result, { out, bytes: fs.statSync(out).size, method: 'element-screenshot' }); }
    }
    result.note = 'CAPTCHA regenerates per request; this is the displayed instance. Do NOT re-fetch the endpoint to read the code.';
  }
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  process.exit(hit ? 0 : 1);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
