# browser-tools — 測試與驗證心得

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

`https://tvcclvalves-preview.fly.dev/en/index.html`(ReadyScript `pc2-template`,故對整個模板的客戶站通用)。同頁同時有**兩家不同的 jQuery slider**:Camera(hero)+ Owl Carousel(產品),是很好的考題。

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
