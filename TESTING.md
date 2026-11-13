# browser-tools — 測試與驗證心得

> 代登入（擴充與 cdp 後端）的測試在本檔後半「代登入的測試」。

針對 pi 的 `browser-tools` skill 新增三項能力,並在真實頁面上實測驗證。

## 為什麼用「skill 腳本」而不是 MCP / agent 框架

- `pi` 沒有 MCP client(只有 bash + skills + extensions),所以工具要做成「**SKILL.md + 被 bash 呼叫的腳本(印 JSON 到 stdout)**」。
- 實測過 Playwright MCP 與 `@playwright/cli`:兩者都是「playwright mcp commands from terminal」,**沒有依 HTTP status 過濾的指令**,也**沒有 `--device` 一級旗標**;且 MCP 要常駐 server + JSON-RPC bridge,和 pi 每回合 bash 退出的模型衝突。
- 結論:用 **Puppeteer/Playwright library 包成腳本**最直接。這裡沿用 skill 既有的 **Puppeteer**(`node_modules` 已內含,**零新依賴**),ESM(skill 是 `type:module`),自起 headless Chromium(免 `:9222`,與既有 CDP-attach 腳本互補)。

## 新增腳本

| 腳本 | 能力 |
|---|---|
| `browser-capture.js` | viewport / **全頁** / 元素裁切 / **手機模擬**(`--device`)截圖 |
| `browser-slider.js` | 逐張截圖**每個 carousel 的每一張** slide |
| `browser-netlog.js` | 擷取所有 response,`--min-status=N` 依 HTTP status 過濾 |

## 驗證對象

`https://<預覽站>/en/index.html`(ReadyScript `pc2-template`,故對整個模板的客戶站通用)。同頁同時有**兩家不同的 jQuery slider**:Camera(hero)+ Owl Carousel(產品),是很好的考題。

## 實測結果(數據)

- **全頁**:`mode=full-page`,`scrollH=3347` 完整擷取。
- **手機**(iPhone 15):`393×659 @ DPR 3`,`maxTouchPoints=1`,iOS UA,`scrollH=4792`(行動版重排,比桌機高)→ 真裝置模擬,非單純縮放。
- **元素裁切**:`--selector=.camera_wrap` 取得 hero 區塊。
- **Slider**:Camera **2/2**、Owl **5/5**,每張 md5 皆不同(全部 distinct)。
- **Network**:42 筆 response,`byStatus {2xx:41, 4xx:1}`;`--min-status=400` 揪出 **真實 404**:`images/dbee5209.gif`(壞圖)。

## 心得 / 踩雷(關鍵)

1. **凍結 CSS 動畫不可一體適用**。`transition/animation:none` 對「軌道型」slider(Owl/Swiper…)有效(終態 transform 直接套用、瞬跳且不糊),但會**破壞「揭示型」**(Camera 靠 opacity 淡入)——凍結後新圖永遠不顯示。→ Camera 改為**點 `.camera_next` + 等 settle**,不凍結。
2. **Camera 的 force-visibility 失效**:`.camera_src > *` 只是資料容器(`data-src`),不是渲染層,強制顯示它拍到的還是同一張。
3. **`[class*="next"]` 會誤中 Camera 的 slide class `cameranext`**(`querySelector` 依 DOM 順序、非選擇器順序,先選到 slide div,點了沒反應)。→ 用**優先序選擇器**(先精準 `.camera_next`/`.owl-next`…,泛型退路限定 `button`/`a` 且只配 `-next`/`next-`)。
4. **排除 clone**:Owl `loop` 會複製 slide(偵測到 11 張),真實張數要 `:not(.cloned)`(= 5)。Swiper/Slick/Splide 同理用各自的 `:not(...duplicate/cloned/clone)`。
5. **驅動策略分型**:軌道型用 lib API **0 動畫**瞬跳(crisp);揭示型用按鈕 + settle;再退到分頁圓點;最後才 force-visibility。每種 settle 時間不同(api 450ms / dots 650ms / next 1300ms / force 350ms)。
6. **每張先等懶載圖**(`img.complete`)再截圖,否則拍到半載入的 slide。

## 設計備註

- 三支皆**自起 headless Chromium**(吃 URL 就跑),與既有「attach `:9222` 操作使用者實時瀏覽器」的腳本是互補的兩種模式。
- 皆為 ESM(`import`),配合 skill 的 `package.json` `"type":"module"`。

---

# 代登入的測試（2026-11-10～11-13，最終狀態：擴充 0.2.11）

代登入的填值端有兩條：owner 日常 Chrome 裡的擴充（主要）與 :9223 headless Chrome 上的 `browser-fill.js`（cdp 後端，備援）。設計與結果代碼見 `README.md` §9，逐版紀錄見 `RELEASES.md`。

## 測試檔與最終結果

| 指令 | 範圍 | 最終結果（2026-11-13，0.2.11） |
|---|---|---|
| `node --test --test-timeout=120000 test/extension.test.mjs` | 擴充：指令、來源比對、遮罩、對話框保護、期限與診斷、清理約定、往返快取、凍結與丟棄 | 118 項全部通過 |
| `node --test test/origin.test.mjs` | `lib` 的來源解析與選頁（`originOf`、`pickPage`），`--expect-origin` 依它比對 | 4 項全部通過 |
| `node --test test/browser-tools.test.mjs` | cdp 後端的腳本：`start` 的埠與設定檔、`fill`（含 `--expect-origin`）、cookie 遮值與 :9223 拒絕、`PI_BROWSER_DENY`、`--host`、對話框自動關閉、逾時、`stop --purge` | 29 項中 28 項通過；失敗的是既有偶發項「載入時跳 alert／confirm 不會卡住」，和擴充無關 |

`npm test` 一次跑 `test/*.test.mjs`，但外層 `timeout 120`（120 秒）對擴充測試太短（95 項時一輪約 447 秒，現在更多），擴充請用上表的指令單獨跑。

## 測試環境的規則

- **擴充測試只用正版 `/Applications/Google Chrome.app`**：先過 `codesign --verify --deep --strict`，沒過就整檔跳過。暫存 user-data-dir、headless、`--remote-debugging-pipe`，用 CDP `Extensions.loadUnpacked` 載入未封裝的 `extension/`（正式版 Chrome 不吃 `--load-extension`）。
- 假原生主程式 `test/extension/fake-host.mjs` 放在暫存設定檔的 `NativeMessagingHosts/`，測試程式扮演 sbd；假網站是測試自己起的本機 HTTP 伺服器。
- **不碰 owner 的 Chrome**、`~/.cache/browser-tools*`、9222／9223；不在測試裡 reload 正式擴充（換版由 `sb ext-reload` 做）。
- `browser-tools.test.mjs` 起獨立的 headless Chrome（:9299、`~/.cache/browser-tools-test-<pid>`），結束時清掉。
- **測試順序**：`reload：回 ok 後重新載入擴充…` 必須是 `extension.test.mjs` 的最後一項。它會重新載入擴充，排在後面的測試會連到已失效的 service worker，一律 120 秒逾時。

## 怎麼模擬現場狀況

| 現場狀況 | 模擬方法 |
|---|---|
| 網站對話框（alert／confirm／beforeunload）、長時間同步工作 | 假站在載入、送出或 pagehide 時跳對話框或忙等；D10 假頁由解析器同步占住主執行緒，另加 CPU 降速回歸（`ac4edf4`） |
| 往返快取恢復（上一頁） | 假站的 pagehide／pageshow 變形（整理 body、移除 `documentElement` 底下節點、rAF／計時器／inline style 蓋遮罩、JS 重建表單回填）；量測用假站自己的取樣器，被換掉時以 sendBeacon 回報 |
| 分頁被 Chrome 凍結（E1-D14） | 另開一條 CDP 連線送 `Page.setWebLifecycleState frozen`，工作分頁放到背景；也測「注入等待中才凍結」與「作用中分頁也凍結（叫不醒）」 |
| 分頁被 Chrome 丟棄（E1-D14b） | 在擴充的 service worker 裡呼叫 `chrome.tabs.discard`，Chrome 會換新的分頁 ID |
| Claude in Chrome 的除錯連線 | 第二條 CDP 連線啟用 Page／Runtime／DOM、取無障礙樹、截圖、`Debugger.setPauseOnExceptions` |

真正的凍結時機（閒置多久、螢幕鎖定、省電）在隔離環境等不出來，以上都是模擬；現場以稽核裡的 `tab_woken`、`tab_frozen` 確認。

## 突變驗證

每輪修正後都做突變驗證：一次拿掉一層防護，只跑相關測試，確認有測試失敗；跑完換回原檔並確認擴充目錄沒有 `.orig`。沒被抓到的突變要說明原因，通常是各層互相重疊（例如 0.2.11 的「bind 不主動重新載入被丟棄的分頁」：Chrome 注入時會自己把分頁載回來）。各輪的突變表在 wl 團隊的任務報告（X2L～X2O）。

## 心得

1. **不要用「等待＋掃描」追網站的時序**。R15～R19 連續五輪都在調等待時間或加掃描範圍，網站總能在核對之後再改畫面；改成「非 OK 就離開網站內容（退到擴充頁）」的契約才收斂。
2. **先實測推定再修**。D14 原先推定是對話框、後來推定是除錯連線，兩者都被實測推翻；用 CDP 凍結分頁才完全重現現場的回覆。
3. **自己引入的問題也要記**：新測試排在 reload 那項之後會全部逾時；分頁換 ID 時把有計時器的狀態直接搬過去，計時器仍綁著舊 ID。
