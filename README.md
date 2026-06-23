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

> This document contains the full design rationale (§1) and the complete test report (§5).
> A condensed, learnings-focused version is in [`TESTING.md`](./TESTING.md).

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

### 既有(沿用,CDP attach `:9222`)
`browser-start` · `browser-nav` · `browser-eval` · `browser-screenshot` · `browser-pick` ·
`browser-cookies` · `browser-content`

---

## 5. Complete test report

### 5.1 環境
| 項目 | 值 |
|---|---|
| OS | macOS (Darwin 24.6.0), arm64 |
| Node / npm | v23.10.0 / 10.9.2 |
| Puppeteer | 24.31.0(bundled Chromium `mac_arm-142.0.7444.175`) |
| pi | v0.74.0(預設模型:本機 `Qwen3.6-27B` via llama-server) |
| 主要測試標的 | `https://tvcclvalves-preview.fly.dev/en/index.html`(ReadyScript `pc2-template`) |
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
U=https://tvcclvalves-preview.fly.dev/en/index.html
node browser-capture.js "$U" --full-page --out=/tmp/full.png
node browser-capture.js "$U" --device="iPhone 15" --full-page --out=/tmp/m.png
node browser-slider.js  "$U" --out=/tmp/slides
node browser-netlog.js  "$U" --min-status=400
node browser-captcha.js https://tvcclvalves-preview.fly.dev/en/page/contact-info.html --out=/tmp/captcha.jpg
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

---

## 8. Licensing & provenance
- **本輪新增**(`browser-capture.js`、`browser-slider.js`、`browser-netlog.js`、`browser-captcha.js`、
  `SKILL.md` 的對應段落、`TESTING.md`、`README.md`):由本工作產生。
- **既有檔案**(其餘 `browser-*.js`、`package.json` 等):沿用原 `browser-tools` skill,隨初始 commit
  `db751de` 一併納入。
- **執行引擎**:Puppeteer 為 **Apache-2.0**。
- **授權聲明**:本 repo **尚未加入 LICENSE 檔**;若要對外發佈,建議先補上明確授權。
- 本 repo 由 pi 的 `browser-tools` skill 演進而來,commit 歷史完整記錄了測試與驗證過程。
