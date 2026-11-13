# pi-browser-tools

Browser-automation scripts for the **`pi`** CLI agent: mobile / desktop / full-page / element
screenshots, dynamic-slider (carousel) capture, network + HTTP-status analysis, and form
verification-image (CAPTCHA) grabbing. The scripts are invoked by `pi` through its `bash` tool
and print JSON to stdout. They run on the Puppeteer already vendored in the skill — no new
runtime dependency.

| | |
|---|---|
| Target consumer | `pi` v0.74.0 (local CLI coding agent) |
| Engine | Puppeteer 24.31.0 (bundled Chromium) |
| Module format | ESM (`"type": "module"`) |
| Status | Verified against one live site; see §5 and the caveats in §7 |
| 代登入擴充 | `extension/` 0.2.11（2026-11-13 結案，見 §9） |

> This document contains the full design rationale (§1) and the complete test report (§5).
> A condensed, learnings-focused version is in [`TESTING.md`](./TESTING.md).
> 代登入（secret-broker 擴充與 cdp 後端）的最終狀態見 §9，逐版紀錄見 [`RELEASES.md`](./RELEASES.md)。

---

## Table of contents
1. [緣由 (Why this exists)](#1-緣由-why-this-exists)
2. [Design principles](#2-design-principles)
3. [Install & use](#3-install--use)
4. [Command reference](#4-command-reference)
5. [Complete test report](#5-complete-test-report)
6. [Key findings](#6-key-findings)
7. [Limitations & what was not covered](#7-limitations--what-was-not-covered)
8. [Licensing & provenance](#8-licensing--provenance)
9. [代登入：最終狀態（2026-11-13）](#9-代登入最終狀態2026-11-13)

---

## 1. 緣由 (Why this exists)

### 1.1 需求
原始需求是替 `pi` 找一套瀏覽器自動化能力,需涵蓋五項硬需求:**手機模式瀏覽、桌機瀏覽、截圖、
network 分析、可依 HTTP status code 過濾**。後續再追加三項:**全頁截圖、動態 slider 逐張截圖、
聯絡表單的驗證圖片 (CAPTCHA) 抓取**。

### 1.2 關鍵限制:`pi` 沒有 MCP client
`pi --help` 確認:pi 的工具整合只有內建工具 (read/bash/edit/write)、skills、extensions 三條路,
**沒有 MCP client**(無 `--mcp` / server / stdio 旗標)。因此「給 pi 一個工具」的正確形態是
**「SKILL.md 描述 + 被 bash 呼叫、輸出 JSON 的腳本」**,而非 MCP server。這項事實推翻了「對 AI agent
而言 Playwright MCP 最乾淨」這種泛用結論——對 pi 並不成立。

### 1.3 選型結論(完整評估見 §5.2)
- **Playwright MCP / `@playwright/cli`**:本質是「playwright mcp commands from terminal」。pi 要用得
  自架 stateful JSON-RPC bridge(與 pi「每回合 bash 子行程退出」的模型衝突);且實測其 CLI **沒有依
  status code 過濾的指令**、**沒有 `--device` 一級旗標**。無法直接滿足需求。
- **AI browser agent 框架**(Browser Use / Stagehand / Skyvern / Steel / BrowserOS):自帶 LLM 推理
  迴圈,會與 pi(本身即 agent)互相競爭,屬**錯誤類別**;Skyvern、BrowserOS 另有 **AGPL-3.0** 授權
  風險(商用情境須留意)。
- **結論**:對 pi 而言,正確形態是**把 Playwright/Puppeteer library 包成 bash 腳本**。由於 pi 既有的
  `browser-tools` skill 已內含 Puppeteer,故以**零新依賴**的方式擴充。

### 1.4 既有 skill 的缺口
pi 既有 `browser-tools`(Puppeteer)已能 nav / eval / screenshot(viewport)/ pick / cookies /
content,但缺:**手機模擬、network 擷取、HTTP-status 過濾、全頁/元素截圖、slider 逐張截圖、CAPTCHA
抓取**。本 repo 補上這些缺口。

---

## 2. Design principles
- **自起 headless Chromium**:新腳本吃 URL 即跑,免 `browser-start.js` / `:9222`。與既有「attach 既有
  Chrome on `:9222`(CDP)」的互動式腳本是**互補的兩種模式**。
- **輸出 JSON 到 stdout**:供 pi 直接解讀,不把大量輸出灌進 context;截圖寫成檔案。
- **機制與判斷分離**:腳本只做確定性的擷取(hands);健康判斷 / 逐頁檢視由 pi 負責(brain)。
- **ESM**:配合 skill 的 `package.json` `"type": "module"`,以 `import` 撰寫。

---

## 3. Install & use
```bash
# 安裝依賴(skill 目錄;取得 puppeteer 與內建 Chromium)
cd browser-tools && npm install

# 以 pi extension 形式安裝(可選)
pi install git:github.com/moregatest/pi-browser-tools
```

### 全域 `pi-browser` 指令(跨技能引用)
要讓**其他技能**呼叫本工具而不依賴 `{baseDir}`,跑一次安裝器,把所有 `browser-*.js`
暴露成全域 `pi-browser` 子指令(symlink 進 `~/.local/bin`,比照本機既有的 `ht` 慣例):
```bash
./install.sh                                            # npm install(若缺)+ 連結 pi-browser 到 PATH
pi-browser --help                                       # 列出所有子指令
pi-browser capture <url> --full-page --out=/tmp/p.png   # = browser-capture.js
```
`pi-browser <x>` 對應 `browser-<x>.js`;bin 目錄可用 `PI_BROWSER_BIN_DIR` 覆寫。

腳本由 pi 透過 bash 呼叫,亦可直接執行:
```bash
node browser-capture.js https://example.com --full-page --out=/tmp/page.png
```

---

## 4. Command reference

### 本輪新增
| 腳本 | 功能 | 主要參數 |
|---|---|---|
| `browser-capture.js` | viewport / 全頁 / 元素 / 手機截圖 | `--full-page` `--selector` `--device` `--viewport` `--out` |
| `browser-slider.js` | 逐張截圖每個 carousel | `--out` `--max` `--selector` `--device` |
| `browser-netlog.js` | 擷取 response,依 HTTP status 過濾 | `--min-status` `--device` |
| `browser-captcha.js` | 抓表單驗證圖(含 iframe) | `--out` `--match` |

完整範例見 [`SKILL.md`](./SKILL.md)。

### Zyte Smart Proxy(選用,預設關閉)
上述四支腳本皆支援 `--zyte`,透過 **Zyte Smart Proxy Manager**(`proxy.zyte.com:8011`)代理流量。

- **預設關閉**,且 SKILL.md **強制 pi 在啟用前先詢問操作者**(「要不要啟動 Zyte proxy?」);未明確同意則不加 `--zyte`。
- API key 取自環境變數 `ZYTE_API_KEY`(或 `SPM_APIKEY`),**不經 CLI 傳遞**;`--zyte` 但無 key 時 **fail-closed**(報錯,不退回直連,避免洩漏真實 IP)。
- `--zyte-profile=desktop` 建議在 headless 下使用;輸出 JSON 會帶 `"proxy": "zyte-spm"`。

**工程決策**:使用者參考的官方套件 `zyte-smartproxy-puppeteer` 硬綁 `puppeteer@^10`(2022 停更),會與本 skill 的 Puppeteer 24 引擎相衝;故**以 Puppeteer 24 原生重寫其行為**(相同 proxy host、相同 `X-Crawlera-*` 控制標頭、apikey 代理認證),不引入過時相依。實作於 [`zyte-proxy.js`](./zyte-proxy.js)。

### 代登入：cdp 後端的腳本（2026-11-10 起；現為備援）
代登入的主要路徑是 owner 日常 Chrome 裡的擴充（見 §9）。下面兩支腳本服務 :9223 headless Chrome 的 cdp 後端，`login-summon.sh --backend auto` 在擴充沒連線時才用。

| 腳本 | 功能 | 主要參數 |
|---|---|---|
| `browser-fill.js` | 從 stdin 讀值寫進指定欄位，值不進命令列、不印出；只操作來源相符的分頁，寫入後再驗來源與長度 | `--selector` `--expect-origin`（`--expect-host` 為舊介面） `--field` |
| `browser-stop.js` | 只關 `PI_BROWSER_PORT` 的 Chrome（CDP `Browser.close`） | `--purge`（一併刪除設定檔目錄） |

`browser-fill.js` 的結束碼：0 `FILLED`、1 `ERROR <類別>`、2 用法錯誤或沒有值、3 寫入前來源不符、4 `NO_FIELD`、5 `FILL_FAILED`（長度不符，已清空）、6 寫入後來源不符（已清空）。

- `--expect-origin`（`c0a1f19`）比對完整來源（scheme＋host＋非預設埠）；sbd 一律用這個。`--expect-host` 只比 host，不分 http／https，保留給舊呼叫端。
- sbd 執行前會比對 `policy.toml` 釘住的 sha256。改了 `browser-fill.js` 要用 `sb login --pin-fill-script` 印出新值，由 owner 寫回設定，否則 sbd 拒絕執行。

其他改動：

- 所有連 CDP 的指令改讀 `PI_BROWSER_PORT`（預設 9222），`start` 讀 `PI_BROWSER_PROFILE_DIR`（預設 `~/.cache/browser-tools`，必須是 `~/.cache/browser-tools*` 且不是符號連結）。共用程式在 `lib/connect.js`。
- `start` 不會把 owner 的日常 Chrome 設定檔複製進代登入／服務權杖專用的 Chrome（F118）：`:9223`（`PI_BROWSER_NO_COPY_PORTS` 可再加埠，不能移除 9223）與名稱含 `login` 的設定檔目錄，不加旗標就等同 `--fresh`，加 `--profile` 會被拒絕並印原因（結束碼 3）。其他埠照舊預設複製。
- `start --fresh` 啟動前真的清空設定檔目錄（以前只是不做 rsync，舊 cookie 與存的密碼都還在）；Chrome 已在執行就沿用、不清空。
- `start` 在 `PI_BROWSER_HIDE_COOKIE=1` 時起背景程序 `lib/cookie-guard.js`，讓每個分頁（含之後才開的）讀 `document.cookie` 一律回空字串，寫入照舊。直接連 CDP 仍讀得到 cookie。
- `cookies` 預設遮值，要看值加 `--values`；在 :9223（代登入專用）一律拒絕。
- `PI_BROWSER_DENY=cmd1,cmd2` 列出的指令直接拒絕（結束碼 77）。
- `nav`、`eval`、`screenshot`、`cookies` 新增 `--host <host>`，只操作網址相符的分頁，找不到就結束碼 3、`URL_MISMATCH`。
- 連線逾時計時器連上後就清掉：以前每個指令都要多等約 5 秒才結束。

測試見 [`TESTING.md`](./TESTING.md)「代登入的測試」。

### 既有(沿用,CDP attach `PI_BROWSER_PORT`，預設 `:9222`)
`browser-start` · `browser-nav` · `browser-eval` · `browser-screenshot` · `browser-pick` ·
`browser-cookies` · `browser-content` · `browser-view`（在你的 Chrome 即時看、點 headless 分頁）

`browser-start` 預設 headless（不開視窗、不搶焦點），要可見視窗加 `--headed`。

---

## 5. Complete test report

### 5.1 環境
| 項目 | 值 |
|---|---|
| OS | macOS (Darwin 24.6.0), arm64 |
| Node / npm | v23.10.0 / 10.9.2 |
| Puppeteer | 24.31.0(bundled Chromium `mac_arm-142.0.7444.175`) |
| pi | v0.74.0(預設模型:本機 `Qwen3.6-27B` via llama-server) |
| 主要測試標的 | `https://<預覽站>/en/index.html`(ReadyScript `pc2-template`) |
| 日期 | 2026-06-22 ~ 2026-06-23 |

### 5.2 選型評估
五項硬需求 = 手機 / 桌機 / 截圖 / network / status 過濾。「實測?」欄區分**實際安裝執行**與**文件/架構評估**。

| 方案 | pi 可用性 | 五需求 | 授權 | 實測? | pi 適配分 (0–10) |
|---|---|---|---|---|---|
| 擴充既有 Puppeteer skill | native-bash | 5/5 | Apache-2.0 | ✅ 實測 | 9.5 |
| Playwright(library 包腳本) | native-bash | 5/5 | Apache-2.0 | ✅ 實測 | 9.0 |
| Playwright MCP | needs-bridge | 4/5(**無 status 過濾**) | Apache-2.0 | ✅ 實測 | 3.5 |
| `@playwright/cli`(pi-playwright) | needs-bridge | 同上 | MIT | ✅ 實測 | — |
| Browser Use | competes-with-pi | gaps 未暴露為指令 | MIT | 文件 | 2.5 |
| Steel Browser | needs-bridge | status ✗ | Apache-2.0 | 文件 | 2.5 |
| Stagehand | needs-bridge | 只值底層 Playwright | MIT | 文件 | 2.0 |
| Skyvern | competes-with-pi | 多半 ✗ | **AGPL-3.0** | 文件 | 1.5 |
| BrowserOS | competes-with-pi | 多半 ✗ | **AGPL-3.0** | 文件 | 1.0 |

實測重點:`@playwright/cli` v0.1.14 的 `open` **無 `--device`**(僅 `resize`);`network` **僅
`--static` / `--clear`,無 status 過濾**。此即「Playwright MCP 系列無法直接滿足需求」的直接證據。
Agent 框架類為文件 / 架構評估——它們自帶 LLM loop,對 pi 屬錯誤類別——並未逐一安裝實測。

### 5.3 能力驗證(實測數據)

**browser-capture.js**
| 模式 | 觀測 |
|---|---|
| 全頁 | `mode=full-page`,`scrollH=3347px`,PNG ≈ 1.57 MB |
| 元素(`--selector=.camera_wrap`) | 裁出 hero 區塊 ≈ 466 KB |
| 手機(`--device="iPhone 15"`) | `innerWidth=393, innerHeight=659, DPR=3, maxTouchPoints=1`,iOS UA,`scrollH=4792` |
| 桌機(`--viewport=1440x900`) | `innerWidth=1440, innerHeight=900, DPR=1` |

→ 為真裝置模擬(UA + touch + DPR),非單純縮放。

**browser-slider.js**(測試頁同時有兩個不同的 jQuery slider)
| Slider | 偵測 | 驅動策略 | 結果 |
|---|---|---|---|
| Camera(hero) | `type=camera`, 2 slides | next-button + settle(不凍結動畫) | **2/2 distinct**(md5 互異) |
| Owl(產品) | `type=owl`, 5 slides(排除 clone) | Owl API,0 動畫瞬跳 | **5/5 distinct**(md5 互異) |

**browser-netlog.js**
- 一次載入擷取 **42** 個 response;`byStatus = {2xx: 41, 4xx: 1}`。
- `--min-status=400` → 1 筆:**`404 images/dbee5209.gif`**(真實壞圖)。

**browser-captcha.js**
| 項目 | 值 |
|---|---|
| endpoint | `readyscript/fb/captcha.php?t=<ts>`(`image/jpeg`,GD-JPEG **200×60**) |
| 位置 | 在 iframe `readyscript/fb/embed.php` **內** |
| 表單欄位 | 驗證碼輸入框 `captcha_response_field`;圖片 `id=captcha_image` |
| 抓取方法 | **intercepted-response**(成功,抓到「當下顯示」那張,內容可讀) |
| 重生驗證 | 同 session 連抓兩次:**5419 vs 5128 bytes(不同)** → 每次請求重生 |
| element 截圖(iframe 內) | **失敗**(299 bytes 空白;跨 iframe 座標) |

### 5.4 全站 QA 掃描(deterministic,50 連結)
自 nav 選單抽出 50 個 EN content 連結,逐一載入並記錄主文件 HTTP 狀態與壞掉的子資源:
- **連結本身全部 `200`**(無死連結)。
- **48 / 50 頁夾帶壞掉資源**,呈三類**系統性(模板層)**缺陷:
  1. `images/dbee5209.gif` → 幾乎每頁 `404`(共用 template / footer 引用)。
  2. `category-flow.<類別>.en.txt` → 每個產品類別 / 材質頁 `404`(category-flow 資料整批未生成)。
  3. `b2a-proxy.php?p=pageflow/TP2|TK2|TR1|TN1` → Globe / Knife Gate / Casting Mark / Needle 4 頁 `404`。
- 唯二乾淨頁:**Performance Reference List**、**A0101 Dual Plate Wafer**。
- 另發現選單錯字:**「Performance *Refernce* List」**(Reference 拼錯)。

→ 結論:問題非個別頁面壞掉,而是**模板層三個共通缺陷**;修 3 處即可修好全站。

### 5.5 pi 逐一檢視(5 頁樣本,本機 Qwen)
由 pi 透過本 skill 對 5 個代表頁逐一檢視,**全部 `rc=0`**,判斷與 §5.4 deterministic 掃描一致:

| 頁面 | status | requests | broken | slider | pi verdict |
|---|---|---|---|---|---|
| Home | 200 | 42 | 1 | camera×2 + owl×5 | minor |
| Company | 200 | 49 | 1 | 無 | minor |
| A01 Check Valve | 200 | 49 | 2 | owl×2 | minor |
| A07 Knife Gate | 200 | 68 | 2(含 `TK2`) | owl×2 | minor |
| Contact Us | 200 | 52 | 1 | 無 | minor |

→ 證明 pi 能以**本機模型**可靠驅動本 skill 做逐頁檢視(機制 = 腳本,判斷 = pi)。

### 5.6 重現指令
```bash
U='https://<預覽站>/en/index.html'   # <預覽站> 換成實際的預覽站網域
node browser-capture.js "$U" --full-page --out=/tmp/full.png
node browser-capture.js "$U" --device="iPhone 15" --full-page --out=/tmp/m.png
node browser-slider.js  "$U" --out=/tmp/slides
node browser-netlog.js  "$U" --min-status=400
node browser-captcha.js 'https://<預覽站>/en/page/contact-info.html' --out=/tmp/captcha.jpg
```

---

## 6. Key findings

**Slider**
1. 凍結 CSS 動畫(`transition/animation:none`)對**軌道型** slider(Owl 等)有效,但會**破壞揭示型**
   (Camera 淡入)→ Camera 改用 `.camera_next` + settle,不凍結。
2. `[class*="next"]` 會誤中 Camera 的 slide class `cameranext`(`querySelector` 依 DOM 順序選取)→ 改
   **優先序選擇器**,泛型退路限定 `button/a` 且只配 `-next` / `next-`。
3. 排除 clone:Owl `loop` 報 11 張,真實 5 張(`:not(.cloned)`)。其餘 lib 同理。
4. 每張先等懶載圖(`img.complete`)再截。

**CAPTCHA**
1. 表單(及驗證圖)在 **iframe** 內,頁面層級查不到。
2. 驗證碼**每次請求重生** → 不可 re-fetch URL(會拿到不同碼),必須攔截「當下顯示」的 response。
3. iframe 內 element 截圖不可靠(跨 frame 座標)→ **攔截法為主**,element 截圖為退路。

---

## 7. Limitations & what was not covered
- **Slider 泛用性**:驅動程式對 **Swiper / Slick / Splide / Bootstrap** 已有對應程式路徑,但本輪僅對
  **Camera + Owl** 做了真實頁面驗證;其餘為 API / 文件層級,**未經 live 實測**。
- **單一站台**:主要在 **ReadyScript `pc2-template`** 一站驗證;跨 CMS 的泛用性未廣泛測試。
- **pi 檢視模型**:逐頁檢視以**本機 `Qwen3.6-27B`** 實測;判斷品質隨模型而異(更強的模型可寫更細的
  人工式評語)。
- **CAPTCHA**:僅「抓取」,**不含 OCR / 解碼**;干擾線會使一般 OCR 不準。
- **網路波動**:測試期間 `httpbin.org` 暫時回 `503`,network 測試改用 `mock.httpstatus.io` /
  `httpbingo.org` 取得混合 status 驗證。
- **Agent 框架評估**:多為文件 / 架構層級(見 §5.2),非逐一安裝實測。
- **Zyte proxy**:已驗證接線(opt-in `--zyte`、無 key 時 fail-closed、proxy 參數正確形成、`proxy:null` 不影響原路徑),但**未對真實 Zyte 帳號做 live 測試**(測試時環境無 API key);亦未實作 `static_bypass` 與 sticky session(啟用時所有流量皆走代理)。

---

## 8. Licensing & provenance
- **本輪新增**(`browser-capture.js`、`browser-slider.js`、`browser-netlog.js`、`browser-captcha.js`、
  `SKILL.md` 的對應段落、`TESTING.md`、`README.md`):由本工作產生。
- **既有檔案**(其餘 `browser-*.js`、`package.json` 等):沿用原 `browser-tools` skill,隨初始 commit
  `db751de` 一併納入。
- **執行引擎**:Puppeteer 為 **Apache-2.0**。
- **授權聲明**:本 repo **尚未加入 LICENSE 檔**;若要對外發佈,建議先補上明確授權。
- 本 repo 由 pi 的 `browser-tools` skill 演進而來,commit 歷史完整記錄了測試與驗證過程。

---

## 9. 代登入：最終狀態（2026-11-13）

本專案在 secret-broker 代登入裡負責「填值端」：主要是 owner 日常 Chrome 裡的 **secret-broker 登入擴充**（`extension/`，0.2.11），備援是 :9223 headless Chrome 上的 `browser-fill.js`（cdp 後端）。帳密只在 sbd 與填值端之間傳遞，雲端代理（Claude）、pi 與本地模型都看不到值。逐版變更見 [`RELEASES.md`](./RELEASES.md)，擴充的指令與機制細節見 [`extension/README.md`](./extension/README.md)，測試見 [`TESTING.md`](./TESTING.md)。

### 9.1 整體流程

```
Claude（對話中撞到登入頁）或 監督者（發現代理停下）
  └─ login-summon.sh（herdr-team）── 佔用 local-model，召喚 pi＋本地模型（llama-tung-mac）
       └─ pi 的 web-login 技能 ── sb browser …／sb web-login-*（secret-broker）
            └─ sbd ── 原生主程式 com.tung.secret_broker（sb native-host）
                 └─ 擴充（owner 的 Chrome，同一個分頁）：bind → fields → fill → click → state → release
```

- **兩個發起點**：
  - 發起點一：Claude 在對話中撞到登入頁（例如用 Claude in Chrome 開的分頁），自己執行召喚，並用 `--tab` 綁同一個分頁。
  - 發起點二：監督分頁的監督者偵測到代理停在登入頁，替它召喚 pi＋本地模型登入。這時分頁通常已閒置數分鐘，容易被 Chrome 凍結或丟棄（見 9.4）。
- 登入成功後，Claude 在同一個分頁接手；帳號、密碼由擴充填入，Claude 不碰值。
- **後端選擇**：`login-summon.sh --backend auto` 先看 `sb ext-status`，印 `CONNECTED` 就走擴充，否則走 :9223 的 cdp 後端。`--tab` 只能配擴充。

### 9.2 擴充與 sbd 的連線

- 擴充 ID 固定為 `ndkjgdfkblmnafdjlpkaoaocdepopoln`（`manifest.json` 的 `key`）。只接受原生主程式的指令；沒有 `externally_connectable`、沒有 `onMessageExternal`，網頁與其他擴充都送不進指令。
- 指令：`ping`、`open`、`bind`、`nav`、`fields`、`click`、`state`、`fill`、`release`、`reload`。每個指令的總期限都比 sbd 的等待短（release 8 秒，sbd 10 秒；其他 15 秒，sbd 20 秒），sbd 不會因等不到回覆而斷線。
- 安裝：`chrome://extensions` 載入未封裝的 `extension/` → `sb native-host install --extension-id ndkjgdfkblmnafdjlpkaoaocdepopoln` → `sb ext-status` 應回 `CONNECTED <版本>`。之後換版一律用 `sb ext-reload`。
- 介面約定的正本在 secret-broker：`docs/superpowers/specs/2026-11-12-ext-backend-protocol.md`。

### 9.3 清理約定（0.2.8 起，0.2.10 補強）

- `release` 的 `outcome` **只認 `"ok"`**。只有登入成功才原地清；缺少、未知或其他值一律退到擴充頁。
- **非 OK、清不乾淨或無法核對**：分頁一律導到擴充自己的 `cleared.html`（只顯示「已清除代填資料」、站名與「回到登入頁」按鈕），回 `cleared_by=extension_page`；sbd 的 `web-login-end` 印 `ENDED_LEFT`。這只表示代填資料已清除，不代表登入成功。
- **離開時移除網站內容**（0.2.10）：清值、蓋遮罩後移除 `documentElement` 底下的網站內容；框架節點只隱藏。
- **往返快取恢復時換成 about:blank**（0.2.10）：已離開的文件被「上一頁」帶回來時，同步蓋遮罩、清內容，再 `location.replace("about:blank")`；背景接著換成擴充頁。
- 期限內換不成擴充頁就照實回 `PAGE_BLOCKED`，不回 ok；sbd 印 `ENDED_UNCLEAN`，召喚端改回 `NEEDS_HUMAN release_failed`。

### 9.4 被凍結與被丟棄的分頁（0.2.11）

- **凍結**：每次注入前看分頁是否被凍結，凍結就 `chrome.tabs.update({active:true})` 切成所在視窗的作用中分頁（不拉視窗到前景、不搶視窗焦點），最多等 1.5 秒。叫不醒（例如作用中分頁也被凍結）時 fill、click 不送出，回 `PAGE_BLOCKED tab_frozen=true`，不再誤報成疑似對話框。
  - **owner 決策 Q14（2026-11-13 已接受）**：owner 正在用同一個視窗時，會看到畫面突然換成登入分頁、鍵盤輸入目標改變。
- **丟棄**：Chrome 丟棄分頁時會換新的分頁 ID。擴充用 `tabs.onReplaced` 記下「舊 ID → 新 ID」（存 `storage.session`），呼叫端拿舊 ID 也找得到；bind 遇到被丟棄的分頁先重新載入、等載完。
- **工作期間不可丟棄**：open、bind 時設 `autoDiscardable:false`，release 與啟動清理時還原原本的設定。
- 診斷：失敗回覆附 `tab_frozen`、`tab_discarded`、`tab_active`；成功回覆附 `tab_woken`、`tab_reloaded`、`tab_replaced`，sbd 記進稽核。

### 9.5 結果代碼一覽

| 層 | 代碼 | 意思 |
|---|---|---|
| 召喚（`login-summon.sh`，印 `LOGIN_RESULT <代碼>`） | `OK` | 登入成功，原代理在同一個分頁接手 |
| | `BAD_CREDENTIALS` | 網站說帳密錯誤 |
| | `NEEDS_HUMAN <原因>` | 交使用者處理。原因：`captcha`、`two_factor`、`fill_failed`、`no_login_form`、`unknown_page`、`other`、`browser_down`、`page_blocked`、`slow_response`（送出後很久仍在登入頁，可能其實已成功）、`release_failed`，以及召喚自己產生的 `no_result`、`interrupted`、`begin_failed`、`workspace_failed`、`pane_run_failed`、`cleanup_failed` |
| | `SITE_NOT_ALLOWED`、`NO_SUCH_ACCOUNT` | 網站不在允許清單、帳密庫沒有這個帳號 |
| | `LOCAL_MODEL_DOWN` | 本地模型不通；不改用雲端模型 |
| | `TIMEOUT`、`BUSY` | 超過期限；本地模型或登入資源被別人佔用 |
| sbd（`sb web-login-end`） | `ENDED`、`ENDED_LEFT`、`ENDED_UNCLEAN` | 結束並原地清掉；結束並已退到擴充頁；工作已結束但清理沒確認 |
| 擴充（回覆的 `error`） | `PAGE_BLOCKED` | 頁面沒有回應（對話框、除錯器暫停、長時間同步工作，或凍結叫不醒）；附 `step` 等診斷 |
| | `NAVIGATING` | `state`／`fields` 時分頁還在導頁或載入，請再讀一次 |
| | `URL_MISMATCH`、`NO_TAB`、`NOT_BOUND` | 來源不符或不能注入；分頁不存在；不是工作分頁 |
| | `NO_FIELD`、`FILL_FAILED`、`NO_ELEMENT`、`NOT_CLICKABLE` | 欄位或按鈕的問題 |
| | `BAD_ARGS`、`UNKNOWN_CMD`、`INTERNAL` | 呼叫端或擴充內部錯誤 |

召喚端代碼的正本是 herdr-team `scripts/login-summon.sh` 開頭的註解。非 OK 一律交使用者，不靠「已經不是登入頁」判成功。

### 9.6 owner 決策

| 題號 | 內容 | 狀態 |
|---|---|---|
| Q2／F48 | 原生主程式的身分沒有綁定 | 2026-11-12 接受殘餘風險，日後改簽章 helper |
| Q14 | 分頁被凍結時切成該視窗作用中分頁喚醒 | 2026-11-13 接受 |
| Q15 | 登入後接手的雲端代理看得到網站自己顯示的帳號；只要求回覆、檔案、commit 不轉述 | 2026-11-13 接受 |

### 9.7 已知風險（摘要，詳見 wl 團隊 BACKLOG「已知風險」）

- **F103**：網站在 window 捕獲階段攔掉 submit 時，cdp 後端判成未送出（不會誤報成功）。
- **F114**：擴充非正常重新載入後，工作分頁可能維持「不可自動丟棄」，只影響記憶體管理。
- **F115**：分頁換 ID 超過十段時，舊 ID 找不到最新分頁，回 `NO_TAB`。
- **F117**：剛建立的非作用中分頁在螢幕鎖定時送出沒生效，回 `slow_response`，使用者再試一次。
- **X2N 極短窗口**：舊文件恢復到換成空白頁之間約 1～12 毫秒，網站刻意對抗時可能短暫顯示；一般整理、回填、重建實測 0 次。
- **跨來源框架**：離開時只隱藏，內部值無法抹除；封閉 shadow root 不在核對範圍。
- **停在空白頁**：兩條背景路徑都失效時，分頁可能停在 about:blank（不顯示舊內容）。
- 其他與本專案無關的項目（F25、F28、F85、F110、F112）見 BACKLOG。
