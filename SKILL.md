---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol. Use when you need to interact with web pages, test frontends, or when user interaction with a visible browser is required.
---

# Browser Tools

Chrome DevTools Protocol tools for agent-assisted web automation. These tools connect to Chrome running on `:9222` with remote debugging enabled.

## Usage Convention

**Always prefer `pi-browser <command>` if installed** (check with `which pi-browser`).
Fall back to `{baseDir}/browser-<command>.js` only if the global CLI is not installed.

## Setup

Run once before first use:

```bash
cd {baseDir}
npm install
bash install.sh   # installs pi-browser globally (symlink to ~/.local/bin)
```

After `install.sh`, verify: `which pi-browser` should return a path.

## Global CLI

`pi-browser <command>` maps 1:1 to `browser-<command>.js`:

```bash
pi-browser --help                                       # list all subcommands
pi-browser capture <url> --full-page --out=/tmp/p.png   # = browser-capture.js
pi-browser netlog  <url> --min-status=400               # = browser-netlog.js
pi-browser slider  <url> --out=/tmp/slides              # = browser-slider.js
```

## Port, profile dir and deny list (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PI_BROWSER_PORT` | `9222` | CDP port every command connects to. `9223` 是代登入 cdp 後端（備援）專用的 Chrome，不要動它。 |
| `PI_BROWSER_PROFILE_DIR` | `~/.cache/browser-tools` | Profile dir for `start` / `stop --purge`. Must be `~/.cache/browser-tools*` (not a symlink), because `--fresh` and `--purge` delete it. |
| `PI_BROWSER_HIDE_COOKIE` | unset | `1`: `start` makes every tab (including tabs opened later) read `document.cookie` as `""`; pages can still set cookies. |
| `PI_BROWSER_DENY` | unset | Comma/space-separated commands to refuse (exit 77), e.g. `cookies,eval`. |
| `PI_BROWSER_NO_COPY_PORTS` | unset | 再加列「不得複製 owner 設定檔」的埠（只能加）。`9223` 固定在清單裡。 |

```bash
PI_BROWSER_PORT=9299 PI_BROWSER_PROFILE_DIR=~/.cache/browser-tools-scratch pi-browser start --fresh
```

## Start Chrome

```bash
pi-browser start              # Copy user's profile (cookies, logins) — default
pi-browser start --fresh      # Fresh empty profile (the profile dir is wiped first)
pi-browser start --profile    # Same as default (backwards-compat alias)
pi-browser start --headed     # Show a Chrome window (default is headless)
```

> **F118**：`:9223`（以及 `PI_BROWSER_NO_COPY_PORTS` 加列的埠）和名稱含 `login` 的設定檔目錄，一律不複製 owner 設定檔：不加旗標就等同 `--fresh`，加 `--profile` 會被拒絕（結束碼 3）。

Chrome on `:9222` runs **headless by default**, so it never pops onto the user's
desktop or steals focus. Pass `--headed` (or set `PI_BROWSER_HEADED=1`) only when
the user explicitly wants a visible window. Note the user agent then contains
`HeadlessChrome`; sites with bot detection may behave differently — use `--headed`
there.

## Watch / click the headless browser

```bash
pi-browser view               # open the most recent :9222 tab in the user's own Chrome
pi-browser view 8421          # pick the tab whose URL contains "8421"
pi-browser view --print       # only print the URL
```

Opens Chrome DevTools for that tab in the user's normal Chrome; the live screen on
the left can be clicked, scrolled and typed into. Offer this when the user wants to
see what the agent is doing.

Launch Chrome with remote debugging on `:9222`. By default it copies the user's
real Chrome profile, so authentication state is preserved. Use `--fresh` when a
clean session (no cookies/logins) is explicitly needed.

> If Chrome is already running on `:9222`, `start` reuses it as-is — it does NOT
> re-sync the profile. To pick up a newly-synced profile, quit that Chrome first.

## Stop Chrome

```bash
pi-browser stop               # close only the Chrome on PI_BROWSER_PORT (CDP Browser.close)
pi-browser stop --purge       # also delete PI_BROWSER_PROFILE_DIR
```

Never kills other Chrome processes. Do not run it against `:9222` unless the user
asks — that is their everyday agent browser.

## Pick the tab by host (`--host`)

`nav`, `eval`, `screenshot` and `cookies` accept `--host <host>` (host includes a
non-default port, e.g. `127.0.0.1:8080`). Only a tab whose URL host matches is used;
none matches → exit 3 and `URL_MISMATCH <hosts>`. Without `--host` they keep the old
behaviour (the last tab). Prefer `--host` whenever more than one tab may be open.

`PI_BROWSER_TARGET_ID=<CDP target id>` binds every command to that one tab (the `id` from
`/json/list` or `PUT /json/new`): other tabs, even on the same host, are never used. With
`--host`, the bound tab must be on that host (else exit 3); `nav --host` may also take the
bound tab while it is still `about:blank`. An unknown or malformed id means no tab (exit 3
with `--host`). The web-login summon uses this so the target-page check reads the login tab.

## Navigate

```bash
pi-browser nav https://example.com
pi-browser nav https://example.com --new
pi-browser nav https://example.com/next --host example.com
```

Navigate to URLs. Use `--new` flag to open in a new tab instead of reusing current tab.

## Evaluate JavaScript

```bash
pi-browser eval 'document.title'
pi-browser eval 'document.querySelectorAll("a").length'
pi-browser eval --host example.com 'location.href'
```

**Never put a password or token into `eval`** — the code is a command-line argument
(visible in `ps`) and the result is printed. Use `fill` instead.

Execute JavaScript in the active tab. Code runs in async context. Use this to extract data, inspect page state, or perform DOM operations programmatically.

## Screenshot

```bash
pi-browser screenshot
pi-browser screenshot --host example.com
```

Capture current viewport and return temporary file path. Use this to visually inspect page state or verify UI changes.

## Pick Elements

```bash
pi-browser pick "Click the submit button"
```

**IMPORTANT**: Use this tool when the user wants to select specific DOM elements on the page. This launches an interactive picker that lets the user click elements to select them. The user can select multiple elements (Cmd/Ctrl+Click) and press Enter when done. The tool returns CSS selectors for the selected elements.

Common use cases:
- User says "I want to click that button" → Use this tool to let them select it
- User says "extract data from these items" → Use this tool to let them select the elements
- When you need specific selectors but the page structure is complex or ambiguous

## 代登入（不要自己登入）

網站要登入時（後台 `<site>/siteoffice/`、或頁面跳到登入表單），**不要用本技能的 `nav`／`eval`／`fill` 自己填帳密**。代登入由 secret-broker 負責：

- 主要路徑：owner 日常 Chrome 裡的「secret-broker 登入」擴充（`extension/`，0.2.11）在**同一個分頁**填值；pi 透過 web-login 技能下 `sb browser …` 指令，看不到值。
- 備援：擴充沒連線時，改用 :9223 的 headless Chrome（cdp 後端），由 sbd 呼叫 `browser-fill.js`。
- 結果非 `OK` 時分頁可能已換成擴充的「已清除代填資料」頁：這只表示代填資料已清除，**不代表登入成功**；不要截圖、讀取或操作那個分頁，交給使用者。
- 登入後看到網站顯示的帳號，不要在回覆、檔案或 commit 裡寫出來。
- 細節見 `README.md` §9 與 `extension/README.md`。

## Fill a credential field (`fill`)

> 這支指令由 sbd 在代登入的 cdp 後端呼叫（執行前比對 `policy.toml` 釘住的 sha256）。
> 你不需要、也不應該自己拿帳密來呼叫它；需要登入時見下面「代登入」。

```bash
printf '%s\n' "$VALUE" | pi-browser fill --selector '#pwd' --expect-origin https://example.com --field password
```

The value is read from **stdin** (one line) — never pass it as an argument. It is
written with CDP `Input.insertText` (fires `beforeinput`/`input`, then `change`) and
never printed. Only a tab whose origin (scheme + host + non-default port) equals
`--expect-origin` is used; the older `--expect-host <host>` compares the host only.
`--field password` requires `type=password`. One output line, and the exit code says what happened:

| Exit | Output | Meaning |
|---|---|---|
| 0 | `FILLED <field>` | written, length verified (the value itself is never read back) |
| 1 | `ERROR <class>` | e.g. no browser; only the exception class is printed |
| 2 | — | usage error or empty stdin |
| 3 | `URL_MISMATCH <hosts>` | no tab on `--expect-origin`／`--expect-host`; nothing was written |
| 4 | `NO_FIELD` | not an `input`, hidden, readonly, disabled, or a password field that is not `type=password` |
| 5 | `FILL_FAILED` | length mismatch (e.g. `maxlength`); the field was cleared |
| 6 | `URL_MISMATCH <host>` | the tab left the expected origin right after writing; the field was cleared if still reachable |

## Cookies

```bash
pi-browser cookies                    # names, domain, path, flags — values hidden
pi-browser cookies --values           # include values (only when really needed)
pi-browser cookies --host example.com
```

Values are hidden unless `--values` is given. Refused (exit 77) on `:9223`, the
web-login (cdp fallback) browser. Never read `document.cookie` there either.

## Extract Page Content

```bash
pi-browser content https://example.com
```

Navigate to a URL and extract readable content as markdown. Uses Mozilla Readability for article extraction and Turndown for HTML-to-markdown conversion. Works on pages with JavaScript content (waits for page to load).

## URL Capture, Mobile, Slider & Network (standalone)

These three scripts launch their **own** headless Chromium (no `browser-start.js` / `:9222` needed) and print JSON to stdout — good for one-shot capture of a public URL. Use `--device="iPhone 15"` (any Puppeteer KnownDevices name) for genuine mobile emulation (UA + touch + DPR).

### Screenshot — viewport / full page / element / mobile

```bash
pi-browser capture <url> --full-page --out=/tmp/page.png
pi-browser capture <url> --selector=".hero" --out=/tmp/hero.png
pi-browser capture <url> --device="iPhone 15" --full-page --out=/tmp/m.png
pi-browser capture <url> --viewport=1440x900 --out=/tmp/d.png
```

`--full-page` captures the whole scrollable page; `--selector` clips one element; `--device` emulates a device; default viewport is 1440x900.

### Dynamic slider / carousel capture

```bash
pi-browser slider <url> --out=/tmp/slides [--max=20] [--selector="<css>"] [--device="iPhone 15"]
```

Screenshots **every slide of every carousel** on the page. It stops autoplay, then drives each slider via its own navigation — 0-duration API for track sliders (Owl, Swiper, Slick, Splide), next-button + settle for reveal sliders (Camera), with pagination-dot and force-visibility fallbacks. Waits for lazy slide images. Outputs `slider<k>-<type>-slide<NN>.png` + a JSON manifest. `--selector` targets one slider.

### Network analysis + HTTP-status filter

```bash
pi-browser netlog <url>                  # all responses + byStatus histogram
pi-browser netlog <url> --min-status=400 # only failures (4xx/5xx)
```

Captures every response (`status`, `resourceType`, `url`); `--min-status=N` keeps only status ≥ N, sorted by status. Surfaces 404 assets and 5xx errors fast. Supports `--device`.

### Form CAPTCHA — live session (PREFERRED)

When you are working with a form **in the live :9222 browser**, use `captcha-live` —
NOT `captcha`. `captcha` launches its own headless browser whose session differs
from the live tab, so the image it grabs is a **different code** than the one on
screen (captcha endpoints regenerate per request). `captcha-live` screenshots the
exact pixels already displayed, then you recognise the code from the image:

```bash
pi-browser captcha-live                      # screenshot displayed captcha + report field/iframe info
pi-browser captcha-live --refresh            # unreadable? click the refresh control and re-shoot
pi-browser captcha-live --fill=a4b7k         # type the recognised code into the right field
```

The JSON reports the input field (name/selector), whether it lives in an iframe,
and a `next` checklist. Read the screenshot image yourself, recognise the code,
then `--fill` it. Submit the form as usual afterwards.

### Verification image (CAPTCHA) grab — standalone browser

Only for grabbing a captcha from a page you are NOT driving live (one-shot,
no live session needed):

```bash
pi-browser captcha <url> --out=/tmp/captcha.jpg
pi-browser captcha <url> --match="captcha|seccode|vcode"   # custom endpoint pattern
```

Grabs a form's verification image, **including ones rendered inside an iframe**
(e.g. ReadyScript `fb/embed.php`). CAPTCHAs are session-bound and **regenerate on
every request**, so re-downloading the URL yields a *different* code than the one
on screen — this captures the exactly-displayed response bytes via interception
(falls back to an element screenshot). Reports the endpoint, image size, the
form's captcha input field name, and whether it lives in an iframe. Saved file
extension auto-matches the content-type (jpg/gif/png).

> ⚠️ **If the form is open in the live browser, use `captcha-live` instead** —
> this command's separate browser has a different session, so the code it
> captures will not match what the user sees.

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
pi-browser capture <url> --full-page --zyte --out=/tmp/page.png
pi-browser capture <url> --device="iPhone 15" --zyte --out=/tmp/m.png   # auto → mobile
pi-browser netlog  <url> --zyte --min-status=400
```

Output JSON reports `"proxy": "zyte-spm"` when the proxy is active (otherwise `null`).

## When to Use

- Testing frontend code in a real browser
- Interacting with pages that require JavaScript
- When user needs to visually see or interact with a page
- Debugging authentication or session issues（要登入時不要自己填帳密，見「代登入」）
- Scraping dynamic content that requires JS execution
- **Form with a CAPTCHA in the live session** → `pi-browser captcha-live` → read the screenshot → `--fill=<code>`

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
sleep 0.5 && pi-browser eval '...'
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
