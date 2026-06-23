#!/usr/bin/env node
// Dynamic slider/carousel capture — screenshots EVERY slide of EVERY carousel on a page.
// Handles autoplay + animation by: stopping autoplay, then driving each slider through
// its OWN navigation (0-duration API for track sliders; next-button + settle for
// reveal sliders like Camera), with pagination-dot and force-visibility fallbacks.
// Supports owl, swiper, slick, splide, bootstrap, Camera, and generic carousels.
//
// Usage: browser-slider.js <url> [--selector=<css>] [--out=<dir>] [--max=N] [--device="iPhone 15"]
import puppeteer from 'puppeteer';
import { launchZyte, newPageZyte, zyteLabel } from './zyte-proxy.js';
import fs from 'node:fs';
const a = (n, d) => { const h = process.argv.find(x => x.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

(async () => {
  const url = process.argv[2];
  const outDir = a('out', '/tmp/slider-shots');
  const maxSlides = parseInt(a('max', '20'), 10);
  const onlySel = a('selector', '');
  const device = a('device', '');
  fs.mkdirSync(outDir, { recursive: true });

  const { browser, zyte } = await launchZyte(puppeteer, { headless: true, args: ['--no-sandbox'] });
  const page = await newPageZyte(browser, zyte);
  if (device && puppeteer.KnownDevices && puppeteer.KnownDevices[device]) await page.emulate(puppeteer.KnownDevices[device]);
  else await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1800)); // let sliders init

  // Detect sliders, tag roots, stop autoplay, pick a driver "kind" per slider.
  const sliders = await page.evaluate((onlySel) => {
    const $ = window.jQuery;
    const sel = onlySel || '.owl-carousel,.swiper,.swiper-container,.slick-slider,.splide,.camera_wrap,.carousel,[class*="carousel"]';
    const typeOf = (el) => {
      const c = ' ' + el.className + ' ';
      if (/owl-carousel/.test(c)) return 'owl';
      if (el.classList.contains('swiper') || el.classList.contains('swiper-container') || el.swiper) return 'swiper';
      if (/slick-slider/.test(c)) return 'slick';
      if (el.classList.contains('splide')) return 'splide';
      if (/camera_wrap/.test(c)) return 'camera';
      if (el.classList.contains('carousel') || el.querySelector('.carousel-item')) return 'bootstrap';
      return 'generic';
    };
    const slidesOf = (el, t) => {
      const q = s => [...el.querySelectorAll(s)];
      if (t === 'owl') return q('.owl-item:not(.cloned)');
      if (t === 'swiper') return q('.swiper-slide:not(.swiper-slide-duplicate)');
      if (t === 'slick') return q('.slick-slide:not(.slick-cloned)');
      if (t === 'splide') return q('.splide__slide:not(.splide__slide--clone)');
      if (t === 'camera') { const s = q('.camera_src > *'); return s.length ? s : q('.cameraSlide'); }
      if (t === 'bootstrap') return q('.carousel-item');
      return q('[class*="slide"]');
    };
    const out = []; let k = 0;
    document.querySelectorAll(sel).forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) return;
      const type = typeOf(el);
      const count = slidesOf(el, type).length;
      if (!count || count > 60) return;
      el.setAttribute('data-pwslider', k);
      try { // stop autoplay
        if (type === 'owl' && $) $(el).trigger('stop.owl.autoplay');
        if (type === 'swiper' && el.swiper && el.swiper.autoplay) el.swiper.autoplay.stop();
        if (type === 'slick' && $) $(el).slick('slickPause');
        if (type === 'splide' && el.splide) el.splide.Components.Autoplay.pause();
        if (type === 'bootstrap' && window.bootstrap) bootstrap.Carousel.getOrCreateInstance(el).pause();
      } catch (e) {}
      const hasApi = (type === 'owl' && $) || (type === 'swiper' && el.swiper) || (type === 'slick' && $) || (type === 'splide' && el.splide);
      const dots = el.querySelectorAll('.owl-dot, .camera_pag_ul li, .slick-dots li, .splide__pagination__page, .carousel-indicators > *');
      const nextSel = ['.camera_next', '.owl-next', '.slick-next', '.splide__arrow--next', '.carousel-control-next', 'button[class*="next"]', 'a[class*="next"]', '[class*="-next"]', '[class*="next-"]'];
      const hasNext = nextSel.some(se => el.querySelector(se));
      const kind = hasApi ? 'api' : (dots.length >= count ? 'dots' : (hasNext ? 'next' : 'force'));
      out.push({ k, type, count, kind, cls: String(el.className).slice(0, 70) });
      k++;
    });
    return out;
  }, onlySel);

  const settle = { api: 450, dots: 650, next: 1300, force: 350 };
  const manifest = [];
  for (const s of sliders) {
    const n = Math.min(s.count, maxSlides);
    const files = [];
    for (let i = 0; i < n; i++) {
      const driver = await page.evaluate((k, i, type, kind) => {
        const root = document.querySelector(`[data-pwslider="${k}"]`);
        const $ = window.jQuery;
        const q = s => [...root.querySelectorAll(s)];
        if (kind === 'api') {
          try {
            if (type === 'owl') { $(root).trigger('to.owl.carousel', [i, 0, true]); return 'owl-api'; }
            if (type === 'swiper') { root.swiper.slideTo(i, 0); return 'swiper-api'; }
            if (type === 'slick') { $(root).slick('slickGoTo', i, true); return 'slick-api'; }
            if (type === 'splide') { root.splide.go(i); return 'splide-api'; }
          } catch (e) {}
        }
        if (kind === 'dots') {
          const dots = q('.owl-dot, .camera_pag_ul li, .slick-dots li, .splide__pagination__page, .carousel-indicators > *');
          if (dots[i]) { dots[i].click(); return 'dot-click'; }
        }
        if (kind === 'next') { // relative: advance one per step (i===0 keeps current slide)
          if (i > 0) {
            const nextSel = ['.camera_next', '.owl-next', '.slick-next', '.splide__arrow--next', '.carousel-control-next', 'button[class*="next"]', 'a[class*="next"]', '[class*="-next"]', '[class*="next-"]'];
            let nx = null; for (const se of nextSel) { nx = root.querySelector(se); if (nx) break; }
            if (nx) nx.click();
          }
          return 'next-click';
        }
        // force-visibility (stacked/fade with no controls)
        const slides = q(type === 'camera' ? '.cameraSlide' : '[class*="slide"]');
        slides.forEach((el, j) => {
          const on = j === i;
          el.style.setProperty('opacity', on ? '1' : '0', 'important');
          el.style.setProperty('visibility', on ? 'visible' : 'hidden', 'important');
          el.style.setProperty('z-index', on ? '999' : '0', 'important');
        });
        return 'force-visibility';
      }, s.k, i, s.type, s.kind);

      await new Promise(r => setTimeout(r, settle[s.kind] || 500));
      await page.evaluate(async (k) => { // wait lazy images in this slider
        const root = document.querySelector(`[data-pwslider="${k}"]`);
        const imgs = [...root.querySelectorAll('img')];
        await Promise.race([
          Promise.all(imgs.map(im => im.complete ? 0 : new Promise(res => { im.onload = im.onerror = res; }))),
          new Promise(res => setTimeout(res, 1500)),
        ]);
      }, s.k);

      const el = await page.$(`[data-pwslider="${s.k}"]`);
      const file = `${outDir}/slider${s.k}-${s.type}-slide${String(i).padStart(2, '0')}.png`;
      try { await el.screenshot({ path: file }); files.push({ i, file, driver, bytes: fs.statSync(file).size }); }
      catch (e) { files.push({ i, driver, error: e.message }); }
    }
    manifest.push({ slider: s.k, type: s.type, kind: s.kind, slides: s.count, captured: files.length, files });
  }
  console.log(JSON.stringify({ url, proxy: zyteLabel(zyte), outDir, sliders: manifest }, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });
