# pi-browser 全域 dispatcher — 實地測試報告

- 日期：2026-06-24
- 範圍：全域 `pi-browser` wrapper 的**跨技能引用**驗證，以及實地測試抓到的手機模擬 regression 修復
- 相關 commit：`2401216`（wrapper）、`8777980`（mobile fix）

---

## 1. 測試環境

| 項目 | 值 |
|---|---|
| OS | macOS（Darwin 24.6.0），arm64 |
| Node / npm | v24.9.0 / 11.6.0 |
| puppeteer | 24.31.0（bundled Chromium） |
| 安裝形態 | `~/.local/bin/pi-browser` symlink → `/Users/tung/Codes/pi-browser-tools/bin/pi-browser` |
| 真實測試標的 | `https://tvcclvalves-preview.fly.dev/en/index.html`（ReadyScript `pc2-template`） |

---

## 2. 測試方法 — 為什麼這能證明「跨技能引用」

所有指令都**從 `/tmp`（repo 外）執行**，透過 PATH 上的 `~/.local/bin/pi-browser`
symlink 呼叫，而非 `node ./browser-*.js`。

關鍵：執行時 CWD = `/tmp`，而 `/tmp` 底下**沒有** `node_modules`。若指令仍能正確
載入 puppeteer 並跑完，就證明相依解析**錨定在腳本的真實位置**（repo），與呼叫者的
CWD、與「當前是哪個技能」完全無關 —— 這正是跨技能引用要的保證。解析原理見 §6。

---

## 3. 測試矩陣與結果

全部 `rc=0`（除刻意的負向案例）。

### 3.1 dispatcher 機制（無需相依／網路）

| 案例 | 指令 | 預期 | 觀測 | 判定 |
|---|---|---|---|---|
| help | `pi-browser --help` | 動態列出子指令 | 列出 12 個（captcha…start） | ✓ |
| 未知指令 | `pi-browser bogus` | 報錯 + `exit 2` | `unknown command 'bogus'`，`exit 2` | ✓ |
| 缺 deps preflight | `pi-browser capture …`（裝 deps 前） | 明確指引 + `exit 1` | 指向 `…/install.sh`，`exit 1` | ✓ |
| 安裝器冪等 | 重跑 `./install.sh` | 跳過 npm install、重連 symlink | `exit 0`、symlink 穩定 | ✓ |

### 3.2 standalone headless 腳本（自起 Chromium，URL→JSON）

| 指令 | 模式 | 觀測 | 判定 |
|---|---|---|---|
| `capture` | viewport | `ft_vp.png` 18590 bytes，1440×900 | ✓ |
| `capture` | full-page | `mode=full-page`；example.com 內容過短（`scrollH=96<900`）故與 viewport 同尺寸（全頁差異另見 README §5.3 fly.dev `scrollH=3347`） | ✓ |
| `capture` | mobile `--device="iPhone 15"` | `w=393 h=659 dpr=3 touch=1`，`ft_m2.png` **1179×1977**（393·3 × 659·3）58687 bytes | ✓（**修復後**，見 §4） |
| `netlog` | 全部 | `total=42`、`byStatus={2xx:41, 4xx:1}`（真實站） | ✓ |
| `netlog` | `--min-status=400` | 真實站濾出 1 筆 404；example.com 濾出 0 筆 | ✓ |
| `netlog` | `--device="iPhone 15"` | named import 不 throw，回正常 JSON | ✓ |
| `slider` | 真實站 | 偵測 `camera`(2) + `owl`(5)，輸出 **7 張 distinct PNG** | ✓ |
| `slider` | example.com | 無 carousel → `sliders: []`，不 crash | ✓ |
| `captcha` | 真實站聯絡頁 | endpoint `readyscript/fb/captcha.php`、`inIframe=true`、`method=intercepted-response`、**200×60 GD-JPEG** 5489 bytes | ✓ |

### 3.3 產出檔佐證

```
/tmp/ft_vp.png          18590 bytes   PNG 1440×900     (viewport)
/tmp/ft_full.png        18590 bytes   PNG 1440×900     (full-page；內容過短)
/tmp/ft_m2.png          58687 bytes   PNG 1179×1977    (iPhone 15，修復後)
/tmp/ft_real_slides/    7 × PNG       slider0-camera-slide00..01 + slider1-owl-slide00..04
/tmp/ft_captcha.jpg     5489 bytes    JPEG 200×60      (GD-JPEG，iframe 內攔截)
```

slider/captcha 的數據與 README §5.3 完全一致 → 透過全域 `pi-browser`（跨目錄、經 symlink）
驅動最複雜的腳本，行為與直接 `node browser-*.js` 相同。

---

## 4. 實地測試發現的缺陷與修復：手機模擬

### 4.1 症狀
透過 `pi-browser capture … --device="iPhone 15"` 實跑時，`observed` 回傳桌機值
（`w=1440 h=900 dpr=1 touch=0`），截圖為 1440×900 —— `--device` **完全未生效**。

### 4.2 根因
`browser-capture.js` / `browser-netlog.js` / `browser-slider.js` 以
`puppeteer.KnownDevices`（**default export 的屬性**）查裝置。但 puppeteer 24.31.0 的
`KnownDevices` 是 **named export**，`puppeteer.KnownDevices` 為 `undefined`，因此
`if (device && puppeteer.KnownDevices && …)` 永遠為偽，`page.emulate()` 從未被呼叫，
落入 else 的桌機預設。README §5.3 宣稱的手機模擬其實未生效。

此缺陷屬**既有腳本**，與本次新增的 dispatcher 無關（wrapper 只是 exec 既有腳本）；
因實地測試抓到、且修復極小，故一併處理。

### 4.3 修復
三支腳本改用 named import 並直接引用：

```diff
-import puppeteer from 'puppeteer';
+import puppeteer, { KnownDevices } from 'puppeteer';
 …
-if (device && puppeteer.KnownDevices && puppeteer.KnownDevices[device]) await page.emulate(puppeteer.KnownDevices[device]);
+if (device && KnownDevices && KnownDevices[device]) await page.emulate(KnownDevices[device]);
```

`browser-captcha.js` 不吃 `--device`，不受影響。

### 4.4 修復前後對比（`--device="iPhone 15"`，example.com）

| 指標 | 修復前 | 修復後 | 期望（`KnownDevices['iPhone 15'].viewport`） |
|---|---|---|---|
| innerWidth | 1440 | **393** | 393 |
| innerHeight | 900 | **659** | 659 |
| devicePixelRatio | 1 | **3** | 3 |
| maxTouchPoints | 0 | **1** | hasTouch:true |
| 截圖像素 | 1440×900 | **1179×1977** | 393·3 × 659·3 |

---

## 5. 重現指令

```bash
# 一次性安裝(npm install + 連結 pi-browser 到 ~/.local/bin)
cd /Users/tung/Codes/pi-browser-tools && ./install.sh

# 以下全部從 repo 外執行,證明跨目錄
cd /tmp
U=https://tvcclvalves-preview.fly.dev/en/index.html

pi-browser --help
pi-browser capture https://example.com --device="iPhone 15" --out=/tmp/m.png
pi-browser netlog  "$U" --min-status=400
pi-browser slider  "$U" --out=/tmp/slides
pi-browser captcha https://tvcclvalves-preview.fly.dev/en/page/contact-info.html --out=/tmp/captcha.jpg
```

---

## 6. 附錄：為什麼 `node_modules` / `zyte-proxy.js` 永遠從 repo 旁解析

三個機制疊起來，使解析與「呼叫者的 CWD／當前技能」完全脫鉤：

### 6.1 dispatcher 在 shell 層先解析出「真實 repo 路徑」再 exec
`bin/pi-browser` 開頭用可攜的「跟著 symlink 走」迴圈解析 `$0` 真實位置：

```sh
src=$0
while [ -h "$src" ]; do
  dir=$(cd -P "$(dirname "$src")" && pwd)
  src=$(readlink "$src")
  case $src in /*) ;; *) src=$dir/$src ;; esac
done
root=$(cd -P "$(dirname "$src")/.." && pwd)
exec node "$root/browser-$cmd.js" "$@"
```

即使從 `/tmp` 呼叫 `~/.local/bin/pi-browser`（symlink），`root` 一律算成
`/Users/tung/Codes/pi-browser-tools`。傳給 `node` 的是**絕對真實路徑**
（`…/pi-browser-tools/browser-capture.js`），不是 symlink、不是相對路徑。

### 6.2 bare specifier：Node 從「模組檔案所在目錄」往上找 node_modules
`browser-capture.js` 內 `import puppeteer from 'puppeteer'`（bare specifier）。Node 的
解析演算法對 bare specifier 是：**從該模組檔案所在目錄**逐層往上找 `node_modules/puppeteer`
—— 起點是**模組的位置**，不是 process 的 CWD。

因 §6.1 保證 node 拿到的 entry 是 `…/pi-browser-tools/browser-capture.js`，查找第一層
就命中 `…/pi-browser-tools/node_modules/puppeteer`。CWD 是 `/tmp`（無 node_modules）也無妨
—— 這正是 §2 那個測試證明的事。

### 6.3 relative specifier：`./zyte-proxy.js` 錨定在 importing module 的 URL
`import { launchZyte } from './zyte-proxy.js'`（relative specifier）對 ESM 是相對
**importing module 的 `import.meta.url`** 解析，同樣與 CWD 無關。因 importing module 是
`…/pi-browser-tools/browser-capture.js`，`./zyte-proxy.js` 一律解析成
`…/pi-browser-tools/zyte-proxy.js`。

### 6.4 為何 symlink 不會破壞它
我們**不依賴** Node 的 symlink 行為 —— 在 shell 層（§6.1）就把真實路徑算好、傳真實路徑給
node。對比被否決的「每支腳本一個 symlink」方案：那才會依賴 Node 預設「先把 main entry 的
symlink 解析成 realpath 再做 module resolution」（除非 `--preserve-symlinks-main`）；雖也
能 work，但較隱晦。dispatcher 在 shell 層解析，最直白、最穩。

### 6.5 反例（避開的坑）
- `exec node "browser-$cmd.js"`（相對 CWD）→ 從 `/tmp` 跑會找不到檔。
- 用 `dirname $0`（symlink 所在的 `~/.local/bin`）當 root，不解析 symlink → root 錯算成
  `~/.local`，找不到 `node_modules`。

兩者皆已避開。

---

## 7. 結論

- 全域 `pi-browser` dispatcher 從 repo 外、經 PATH symlink，對 capture / netlog / slider /
  captcha 四支 standalone 腳本（含真實站的 carousel 與 iframe CAPTCHA）全數跑通，行為與直接
  `node browser-*.js` 相同 → **跨技能引用實際成立**。
- 實地測試額外抓到並修復既有手機模擬 regression（`KnownDevices` named export）；修復後
  iPhone 15 模擬與 README §5.3 數據一致。
- 既有 `browser-*.js` 的相依解析與 dispatcher 解耦，原理見 §6。
