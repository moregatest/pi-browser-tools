// Zyte Smart Proxy Manager (SPM) integration for the browser-tools scripts.
//
// Modeled on zytedata/zyte-smartproxy-puppeteer (same proxy host, X-Crawlera-* control
// headers, and apikey auth) but reimplemented for Puppeteer 24: the official package pins
// `puppeteer@^10` (last published 2022) and would fork in an incompatible 3-year-old engine.
//
// OPT-IN + FAIL-CLOSED:
//   • A script proxies through Zyte ONLY when `--zyte` is passed.
//   • The key comes from the environment (ZYTE_API_KEY or SPM_APIKEY) — never a CLI arg.
//   • `--zyte` with no key throws (no silent direct fallback — avoids leaking the real IP).
//   • SKILL.md REQUIRES pi to ask the operator before adding `--zyte`.
//
// Notes: every request is routed through SPM (no static-asset bypass). SPM MITMs HTTPS,
// so cert validation is relaxed while proxying. `--zyte-profile=desktop` is recommended in
// headless mode (SPM's default headless fingerprint is more detectable).

const DEFAULT_HOST = process.env.ZYTE_SPM_HOST || 'http://proxy.zyte.com:8011';

function defaultHeaders(profile) {
  return {
    'X-Crawlera-No-Bancheck': '1',
    'X-Crawlera-Profile': profile || 'pass',
    'X-Crawlera-Cookies': 'disable',
    'X-Crawlera-Client': 'pi-browser-tools',
  };
}

export function zyteFromArgs(argv = process.argv) {
  if (!argv.includes('--zyte')) return { enabled: false };
  const apikey = process.env.ZYTE_API_KEY || process.env.SPM_APIKEY || process.env.ZYTE_SMARTPROXY_APIKEY || '';
  const profile = (argv.find(a => a.startsWith('--zyte-profile=')) || '').split('=')[1] || '';
  return { enabled: true, apikey, host: DEFAULT_HOST, headers: defaultHeaders(profile) };
}

// Merge Zyte settings into a puppeteer.launch() options object.
export function zyteLaunchOptions(zyte, base = {}) {
  const args = base.args ? [...base.args] : [];
  if (!zyte.enabled) return { ...base, args };
  if (!zyte.apikey) {
    throw new Error('Zyte requested (--zyte) but no API key in env. Set ZYTE_API_KEY (or SPM_APIKEY). ' +
      'Refusing to run without the proxy (fail-closed) so the real IP is not leaked.');
  }
  args.push(`--proxy-server=${zyte.host}`, '--disable-site-isolation-trials', '--ignore-certificate-errors');
  return { ...base, args, acceptInsecureCerts: true };
}

// Apply proxy auth + SPM control headers to a freshly created page.
export async function zyteApplyToPage(page, zyte) {
  if (!zyte.enabled) return;
  await page.authenticate({ username: zyte.apikey, password: '' }); // SPM auth: apikey as proxy user
  await page.setExtraHTTPHeaders(zyte.headers);
}

// Convenience wrappers used by the scripts ------------------------------------------------

export async function launchZyte(puppeteer, base = {}, argv = process.argv) {
  const zyte = zyteFromArgs(argv);
  const browser = await puppeteer.launch(zyteLaunchOptions(zyte, base));
  return { browser, zyte };
}

export async function newPageZyte(browser, zyte) {
  const page = await browser.newPage();
  await zyteApplyToPage(page, zyte);
  return page;
}

export const zyteLabel = zyte => (zyte && zyte.enabled ? 'zyte-spm' : null);
