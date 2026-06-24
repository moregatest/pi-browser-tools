---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, or when user interaction with a visible browser is required.
---

# Browser Tools

Chrome DevTools Protocol tools for agent-assisted web automation. These tools connect to Chrome running on `:9222` with remote debugging enabled.

## Setup

Run once before first use:

```bash
cd {baseDir}/browser-tools
npm install
```

## Global CLI (cross-skill use)

Run `{baseDir}/install.sh` once to expose every script as a global `pi-browser`
subcommand on your PATH (symlinked into `~/.local/bin`, mirroring the `ht`
convention). **Other skills** can then drive these tools without knowing this
skill's directory — they call `pi-browser <command>` instead of
`{baseDir}/browser-<command>.js`:

```bash
pi-browser capture <url> --full-page --out=/tmp/p.png   # = browser-capture.js
pi-browser netlog  <url> --min-status=400               # = browser-netlog.js
pi-browser slider  <url> --out=/tmp/slides              # = browser-slider.js
pi-browser --help                                       # list all subcommands
```

`pi-browser <x>` maps 1:1 to `browser-<x>.js`. Inside *this* skill the
`{baseDir}/browser-*.js` forms below still work; cross-skill callers should
prefer the global `pi-browser` form.

## Start Chrome

```bash
{baseDir}/browser-start.js              # Fresh profile
{baseDir}/browser-start.js --profile    # Copy user's profile (cookies, logins)
```

Launch Chrome with remote debugging on `:9222`. Use `--profile` to preserve user's authentication state.

## Navigate

```bash
{baseDir}/browser-nav.js https://example.com
{baseDir}/browser-nav.js https://example.com --new
```

Navigate to URLs. Use `--new` flag to open in a new tab instead of reusing current tab.

## Evaluate JavaScript

```bash
{baseDir}/browser-eval.js 'document.title'
{baseDir}/browser-eval.js 'document.querySelectorAll("a").length'
```

Execute JavaScript in the active tab. Code runs in async context. Use this to extract data, inspect page state, or perform DOM operations programmatically.

## Screenshot

```bash
{baseDir}/browser-screenshot.js
```

Capture current viewport and return temporary file path. Use this to visually inspect page state or verify UI changes.

## Pick Elements

```bash
{baseDir}/browser-pick.js "Click the submit button"
```

**IMPORTANT**: Use this tool when the user wants to select specific DOM elements on the page. This launches an interactive picker that lets the user click elements to select them. The user can select multiple elements (Cmd/Ctrl+Click) and press Enter when done. The tool returns CSS selectors for the selected elements.

Common use cases:
- User says "I want to click that button" → Use this tool to let them select it
- User says "extract data from these items" → Use this tool to let them select the elements
- When you need specific selectors but the page structure is complex or ambiguous

## Cookies

```bash
{baseDir}/browser-cookies.js
```

Display all cookies for the current tab including domain, path, httpOnly, and secure flags. Use this to debug authentication issues or inspect session state.

## Extract Page Content

```bash
{baseDir}/browser-content.js https://example.com
```

Navigate to a URL and extract readable content as markdown. Uses Mozilla Readability for article extraction and Turndown for HTML-to-markdown conversion. Works on pages with JavaScript content (waits for page to load).

## URL Capture, Mobile, Slider & Network (standalone)

These three scripts launch their **own** headless Chromium (no `browser-start.js` / `:9222` needed) and print JSON to stdout — good for one-shot capture of a public URL. Use `--device="iPhone 15"` (any Puppeteer KnownDevices name) for genuine mobile emulation (UA + touch + DPR).

### Screenshot — viewport / full page / element / mobile

```bash
{baseDir}/browser-capture.js <url> --full-page --out=/tmp/page.png
{baseDir}/browser-capture.js <url> --selector=".hero" --out=/tmp/hero.png
{baseDir}/browser-capture.js <url> --device="iPhone 15" --full-page --out=/tmp/m.png
{baseDir}/browser-capture.js <url> --viewport=1440x900 --out=/tmp/d.png
```

`--full-page` captures the whole scrollable page; `--selector` clips one element; `--device` emulates a device; default viewport is 1440x900.

### Dynamic slider / carousel capture

```bash
{baseDir}/browser-slider.js <url> --out=/tmp/slides [--max=20] [--selector="<css>"] [--device="iPhone 15"]
```

Screenshots **every slide of every carousel** on the page. It stops autoplay, then drives each slider via its own navigation — 0-duration API for track sliders (Owl, Swiper, Slick, Splide), next-button + settle for reveal sliders (Camera), with pagination-dot and force-visibility fallbacks. Waits for lazy slide images. Outputs `slider<k>-<type>-slide<NN>.png` + a JSON manifest. `--selector` targets one slider.

### Network analysis + HTTP-status filter

```bash
{baseDir}/browser-netlog.js <url>                  # all responses + byStatus histogram
{baseDir}/browser-netlog.js <url> --min-status=400 # only failures (4xx/5xx)
```

Captures every response (`status`, `resourceType`, `url`); `--min-status=N` keeps only status ≥ N, sorted by status. Surfaces 404 assets and 5xx errors fast. Supports `--device`.

### Verification image (CAPTCHA) grab

```bash
{baseDir}/browser-captcha.js <url> --out=/tmp/captcha.jpg
{baseDir}/browser-captcha.js <url> --match="captcha|seccode|vcode"   # custom endpoint pattern
```

Grabs a form's verification image, **including ones rendered inside an iframe** (e.g. ReadyScript `fb/embed.php`). CAPTCHAs are session-bound and **regenerate on every request**, so re-downloading the URL yields a *different* code than the one on screen — this captures the exactly-displayed response bytes via interception (falls back to an element screenshot). Reports the endpoint, image size, the form's captcha input field name, and whether it lives in an iframe. Saved file extension auto-matches the content-type (jpg/gif/png).

### Zyte Smart Proxy (optional — OFF by default, ASK FIRST)

`browser-capture.js`, `browser-slider.js`, `browser-netlog.js`, and `browser-captcha.js` can route traffic through **Zyte Smart Proxy Manager** with `--zyte`. It is **disabled by default**.

> **MANDATORY GATE — you (pi) MUST ask the operator before enabling Zyte.**
> Before adding `--zyte` to any command, ask in plain language — e.g. *「要不要啟動 Zyte proxy?（會走付費代理流量）」* — and wait for an explicit **yes**. Never add `--zyte` silently, by default, or on your own initiative. If the operator does not clearly confirm, run **without** `--zyte`.

Behavior:
- API key comes from the environment: `ZYTE_API_KEY` (or `SPM_APIKEY`). **Never** pass a key on the CLI.
- `--zyte` with no key → the script **fails closed** (errors out, no direct fallback) so the real IP is not leaked.
- All requests are routed through SPM (no static-asset bypass); HTTPS cert validation is relaxed while proxying (SPM MITMs TLS).
- **SPM profile auto-detection**: when `--device` is set, the SPM profile is inferred automatically:
  - Mobile devices (iPhone, Galaxy, Pixel…) → `mobile`
  - Desktop / no device → `desktop` (recommended for headless)
  - Use `--zyte-spm-profile=<desktop|mobile|pass>` to override explicitly.

Once the operator confirms:

```bash
{baseDir}/browser-capture.js <url> --full-page --zyte --out=/tmp/page.png
{baseDir}/browser-capture.js <url> --device="iPhone 15" --zyte --out=/tmp/m.png   # auto → mobile
{baseDir}/browser-netlog.js  <url> --zyte --min-status=400
```

Output JSON reports `"proxy": "zyte-spm"` when the proxy is active (otherwise `null`).

## When to Use

- Testing frontend code in a real browser
- Interacting with pages that require JavaScript
- When user needs to visually see or interact with a page
- Debugging authentication or session issues
- Scraping dynamic content that requires JS execution

---

## Efficiency Guide

### DOM Inspection Over Screenshots

**Don't** take screenshots to see page state. **Do** parse the DOM directly:

```javascript
// Get page structure
document.body.innerHTML.slice(0, 5000)

// Find interactive elements
Array.from(document.querySelectorAll('button, input, [role="button"]')).map(e => ({
  id: e.id,
  text: e.textContent.trim(),
  class: e.className
}))
```

### Complex Scripts in Single Calls

Wrap everything in an IIFE to run multi-statement code:

```javascript
(function() {
  // Multiple operations
  const data = document.querySelector('#target').textContent;
  const buttons = document.querySelectorAll('button');
  
  // Interactions
  buttons[0].click();
  
  // Return results
  return JSON.stringify({ data, buttonCount: buttons.length });
})()
```

### Batch Interactions

**Don't** make separate calls for each click. **Do** batch them:

```javascript
(function() {
  const actions = ["btn1", "btn2", "btn3"];
  actions.forEach(id => document.getElementById(id).click());
  return "Done";
})()
```

### Typing/Input Sequences

```javascript
(function() {
  const text = "HELLO";
  for (const char of text) {
    document.getElementById("key-" + char).click();
  }
  document.getElementById("submit").click();
  return "Submitted: " + text;
})()
```

### Reading App/Game State

Extract structured state in one call:

```javascript
(function() {
  const state = {
    score: document.querySelector('.score')?.textContent,
    status: document.querySelector('.status')?.className,
    items: Array.from(document.querySelectorAll('.item')).map(el => ({
      text: el.textContent,
      active: el.classList.contains('active')
    }))
  };
  return JSON.stringify(state, null, 2);
})()
```

### Waiting for Updates

If DOM updates after actions, add a small delay with bash:

```bash
sleep 0.5 && {baseDir}/browser-eval.js '...'
```

### Investigate Before Interacting

Always start by understanding the page structure:

```javascript
(function() {
  return {
    title: document.title,
    forms: document.forms.length,
    buttons: document.querySelectorAll('button').length,
    inputs: document.querySelectorAll('input').length,
    mainContent: document.body.innerHTML.slice(0, 3000)
  };
})()
```

Then target specific elements based on what you find.
