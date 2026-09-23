#!/usr/bin/env node
// Screenshot the CAPTCHA image ALREADY DISPLAYED in the live :9222 browser (including inside
// iframes) and report where to type the code. Use this — not browser-captcha.js — when you are
// working with a form in the live session: captcha endpoints regenerate per request, so any
// separately-launched browser would fetch a DIFFERENT image than the one on screen.
//
// Recommended loop: run this → read the screenshot image → recognise the code → run again with
// --fill=CODE to type it into the right field (handles iframes automatically).
//
// Usage: browser-captcha-live.js [--out=file] [--match=regex] [--fill=CODE] [--refresh]
//
// Options:
//   --out=<file>     screenshot path (default /tmp/captcha-live.png)
//   --match=<regex>  regex to locate the CAPTCHA image by URL/id/class (default: common names)
//   --fill=CODE      type CODE into the detected captcha input field (in its own frame) and exit
//   --refresh        click a refresh/reload control next to the captcha, re-shoot, and exit
//                    (use when the code is unreadable)

import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const a = (n, d) => { const h = process.argv.find(x => x.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const has = (n) => process.argv.includes(`--${n}`);
const DEFAULT_RE = 'captcha|verif|seccode|vcode|checkcode|authcode|securimage|kcaptcha|getcode|imgcode|valicode|randcode';

const fillCode = a('fill', null);
const wantRefresh = has('refresh');
const out = a('out', '/tmp/captcha-live.png');
const matchRe = new RegExp(a('match', '') || DEFAULT_RE, 'i');

// Locate the captcha <img> (and its input field) in a frame.
async function findIn(frame) {
	return frame.evaluate((src) => {
		const re = new RegExp(src, 'i');
		const abs = u => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
		const imgs = [...document.querySelectorAll('img')];
		let im = imgs.find(x => re.test(x.getAttribute('src') || '') || re.test(x.id || '') || re.test(String(x.className)));
		if (!im) im = imgs.find(x => /\.(php|asp|aspx|jsp|cgi|ashx)(\?|$)/i.test(x.getAttribute('src') || '') && x.naturalWidth > 30 && x.naturalWidth < 320 && x.naturalHeight < 120);
		if (!im) return null;
		const r = im.getBoundingClientRect();
		const cssEsc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/(["\\])/g, '\\$1');
		let selector = im.id ? `img#${cssEsc(im.id)}`
			: im.name ? `img[name="${cssEsc(im.name)}"]`
			: `img[src*="${(im.getAttribute('src') || '').split('?')[0].slice(-40)}"]`;
		const field = [...document.querySelectorAll('input[type=text],input:not([type])')].find(i => /captcha|code|verif|valid|chk/i.test((i.name || '') + (i.id || '')));
		const fieldSel = field ? (field.id ? `#${cssEsc(field.id)}` : `input[name="${cssEsc(field.name)}"]`) : null;
		// refresh control: a link/button/img near the captcha whose text/attrs hint at reload
		const near = [im.parentElement, im.parentElement?.parentElement].filter(Boolean);
		let refreshSel = null;
		outer: for (const p of near) {
			for (const el of p.querySelectorAll('a,button,img,span,i')) {
				const hint = ((el.id || '') + ' ' + String(el.className) + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('alt') || '') + ' ' + (el.textContent || '')).toLowerCase();
				if (/refresh|reload|renew|換一張|看不清|重新|另一張/.test(hint)) {
					refreshSel = el.id ? `${el.tagName.toLowerCase()}#${cssEsc(el.id)}`
						: el.className ? `${el.tagName.toLowerCase()}.${[...el.classList].map(cssEsc).join('.')}`
						: `${el.tagName.toLowerCase()}[title="${cssEsc(el.getAttribute('title') || '')}"]`;
					break outer;
				}
			}
		}
		return {
			selector, refreshSel, fieldSel,
			fieldName: field ? (field.name || field.id || null) : null,
			fieldValue: field ? field.value : null,
			src: abs(im.getAttribute('src')), imgId: im.id || '',
			naturalW: im.naturalWidth, naturalH: im.naturalHeight,
			dispW: Math.round(r.width), dispH: Math.round(r.height),
			formAction: document.querySelector('form') ? abs(document.querySelector('form').getAttribute('action')) : null,
		};
	}, matchRe.source).catch(() => null);
}

async function locate(page) {
	let hit = await findIn(page.mainFrame());
	if (hit) return { hit, frame: page.mainFrame(), frameUrl: null, inIframe: false };
	for (const f of page.frames()) {
		if (f === page.mainFrame()) continue;
		const r = await findIn(f);
		if (r) return { hit: r, frame: f, frameUrl: f.url(), inIframe: true };
	}
	return null;
}

(async () => {
	const browser = await Promise.race([
		puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null }),
		new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
	]).catch(() => null);
	if (!browser) {
		console.error('✗ Could not connect to the live browser on :9222');
		console.error('  Run: pi-browser start');
		process.exit(1);
	}
	const page = (await browser.pages()).at(-1);
	if (!page) { console.error('✗ No active tab'); process.exit(1); }

	if (fillCode !== null) {
		const loc = await locate(page);
		if (!loc) { console.log(JSON.stringify({ filled: false, error: 'captcha field not found in live tab' }, null, 2)); process.exit(1); }
		const filled = await loc.frame.evaluate((sel, code) => {
			const el = document.querySelector(sel);
			if (!el) return false;
			el.focus();
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
			setter.call(el, code);
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return el.value === code;
		}, loc.hit.fieldSel, fillCode).catch(() => false);
		console.log(JSON.stringify({
			filled, code: fillCode, field: loc.hit.fieldName, selector: loc.hit.fieldSel,
			inIframe: loc.inIframe, frameUrl: loc.frameUrl,
			tab: page.url(),
			note: filled ? 'value set + input/change dispatched. Submit via the form as usual.' : 'fill failed — check field selector',
		}, null, 2));
		process.exit(filled ? 0 : 1);
	}

	fs.mkdirSync(path.dirname(out), { recursive: true });

	let loc = await locate(page);
	if (loc && wantRefresh && loc.hit.refreshSel) {
		await loc.frame.evaluate(sel => document.querySelector(sel)?.click(), loc.hit.refreshSel).catch(() => {});
		await new Promise(r => setTimeout(r, 1500));
		loc = await locate(page);
	}
	if (!loc) {
		console.log(JSON.stringify({ found: false, tab: page.url(), hint: 'no captcha-like <img> on the live tab. If the form is on another tab, focus it first (pi-browser nav <url> to reuse/re-open), or pass --match=<regex>.' }, null, 2));
		process.exit(1);
	}

	// Screenshot the EXACT displayed pixels (element shot, not a re-fetch).
	let img = await loc.frame.$(loc.hit.selector).catch(() => null);
	if (!img) img = await loc.frame.$('img').catch(() => null);
	let shot = null;
	if (img) {
		await img.evaluate(e => e.scrollIntoView({ block: 'center' })).catch(() => {});
		await new Promise(r => setTimeout(r, 300));
		await img.screenshot({ path: out }).catch(() => {});
		if (fs.existsSync(out)) shot = { out, bytes: fs.statSync(out).size, method: 'live-element-screenshot' };
	}

	console.log(JSON.stringify({
		found: true, tab: page.url(),
		captcha: {
			endpoint: loc.hit.src, imgId: loc.hit.imgId || null,
			naturalSize: loc.hit.naturalW + 'x' + loc.hit.naturalH,
			displaySize: loc.hit.dispW + 'x' + loc.hit.dispH,
			selector: loc.hit.selector, refreshSelector: loc.hit.refreshSel,
			inIframe: loc.inIframe, frameUrl: loc.frameUrl,
			inputField: loc.hit.fieldName, inputSelector: loc.hit.fieldSel,
			currentValue: loc.hit.fieldValue || '',
			formAction: loc.hit.formAction,
		},
		screenshot: shot,
		next: [
			'read the screenshot image and recognise the code',
			`pi-browser captcha-live --fill=<CODE>   # types into ${loc.hit.fieldSel || 'the field'}`,
			loc.hit.refreshSel ? 'pi-browser captcha-live --refresh   # unreadable? click refresh and re-shoot' : null,
		].filter(Boolean),
	}, null, 2));
	process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
