# 更新紀錄（RELEASES）

新的在上面。代登入擴充（`extension/`）的版本號取自 `extension/manifest.json`；其他腳本沒有獨立版本號，以日期與 commit 標示。缺陷編號（`E1-D…`、`R…-…`、`F…`）對應 wl 團隊的 `BACKLOG.md` 修正紀錄與各任務報告。

## 最終狀態（2026-11-13）

- 擴充 **0.2.11**（`07a7338`），代登入主線已結案：複審（R23）沒有高、中缺陷；完整回歸（發起點一、發起點二，含 auto mode）全部通過。
- 擴充自動測試 118 項全部通過；`origin.test.mjs` 4 項全部通過；`browser-tools.test.mjs` 29 項中 28 項通過，失敗的是既有偶發項「載入時跳 alert／confirm 不會卡住」（見 `TESTING.md`）。
- 已知風險見下面「已知風險（0.2.11）」與 `README.md`「代登入」一節。

---

## 腳本 — 2026-11-13（MF16，R33-D1）

- **R33-D1（高）**：`browser-fill.js` 最後一次來源檢查之後，還要先建立 CDP 工作階段，再用 `Input.insertText` 寫進「當時的焦點」。同一個分頁在這段空檔導到別的來源時，值會進新文件（寫後檢查與清空只能事後發現）。
- **修正**：交值綁在已驗證的文件與欄位上。
  - CDP 工作階段改在來源檢查與找欄位之前建立；找欄位改用 `Runtime.evaluate` 取得欄位的 objectId（屬於該文件的執行環境）。
  - 寫入改用 `Runtime.callFunctionOn(objectId)`：函式內同步確認 `location.origin`（`--expect-host` 時是 `location.host`）與欄位仍在文件上、仍合格，才用原生 value setter 寫入。確認與寫入在同一個工作裡完成。
  - 文件換代時執行環境與 objectId 一起失效，呼叫直接失敗，值不會進新文件：換到別的來源回 3 `URL_MISMATCH`，同來源換了文件回 4 `NO_FIELD`，都表示值沒有交出。
  - input／change 改在下一個工作送出（`InputEvent`，`inputType: "insertText"`），避免頁面的 input 處理器同步導頁讓回覆遺失；計時器屬於原文件，文件換掉就不觸發。
  - 不再用 `Input.insertText`；值超過 `maxlength` 時不寫入，回 5 `FILL_FAILED`。
  - 結束碼的數字不變。
- **測試**：新增 `test/fill-race.test.mjs` 3 項（真 headless Chrome、暫存設定檔、隨機埠；`fill-race-hook.mjs` 在寫值指令送出前插入導覽）：跨來源換文件、同來源重新載入、沒有注入時照常寫入。`browser-tools.test.mjs` 新增「清空欄位時就被導走」1 項；夾具 `#jump` 改成有值才導走，讓「寫入後被導走 → 6」真的測到寫入之後。
- **雜湊改變**：sbd 的 policy 要更新 `browser_fill_sha256`（由主控或 owner 做）。

---

## 腳本 — 2026-11-13（MF10，R30-D4）

- **R30-D4（中）**：代登入 cdp 後端的目標頁核對用 `eval --host` 挑「同主機最後一個分頁」，登入分頁被導到說明頁、另一個同主機分頁剛好在目標頁時會誤判成功。新增環境變數 `PI_BROWSER_TARGET_ID`：`nav`、`eval`、`screenshot`、`cookies`、`fill`（經 `lib/connect.js` 的 `pickPage`）只操作這個 CDP target id 的分頁；帶 `--host` 時該分頁必須在那個主機，否則結束碼 3；`nav --host` 可以把還在 `about:blank` 的綁定分頁導過去。id 找不到或格式不符就是沒有分頁，不退回其他挑法。沒設這個變數時行為不變。
- **測試**：`browser-tools.test.mjs` 新增 2 項（綁定分頁時同主機其他分頁不算、id 無效不退回）。

## 擴充 0.3.2 — 2026-11-13（MF4，R28-1）

- **R28-1（中）**：0.3.1 在轉送前做非同步雜湊，每筆捕獲各自進行，第一筆雜湊較慢時第二筆先轉送，sbd 會把較舊的嘗試當成目前候選。改成每個工作在捕獲入口依到達順序排隊（上限 16），逐筆完成雜湊與轉送；停止收斂等已入列的捕獲。
- **測試**：新增 2 項（第一筆雜湊延遲仍依序送達、雜湊延遲中停止仍收斂）；`test/enroll.test.mjs` 30 項、`test/extension.test.mjs` 118 項全過。

## 擴充 0.3.1 — 2026-11-13（MF1，R27-1、R27-4）

- **R27-1（高）**：停止補登時，延遲送出中的捕獲被丟掉，計數又不含它，sbd 誤判清理集完整而回原地清乾淨。改成停止時先送出、等送達再停收；`enroll_stop` 回讀到的數目與 `complete`；清理集沒涵蓋轉送過的值就不原地清。
- **R27-4（中）**：同表單 1 秒內的第二次可信操作被當成重複。改成只認 Enter 衍生的點擊。
- **測試**：`test/enroll.test.mjs` 28 項、`test/extension.test.mjs` 118 項全過。

## 擴充 0.3.0 — 2026-11-13（M2，主線 3 補登）

- **為何**：未建檔帳密的補登（設計 secret-broker `2026-11-13-webcred-enroll-design.md`，經 N1R～N6R 複審）。owner 自己登入一次，擴充在送出那一刻把帳密交給 sbd，sbd 獨立驗證通過才記下。
- **改了什麼**：新增 `enroll_*` 指令、`enroll-capture.js`、提示列與徽章（manifest 加 `action` 鍵，權限不變）、四種事件、補登分頁與代登入工作分頁互斥、斷線時自行退頁與重啟回報。細節見 `extension/README.md`「補登」一節。
- **測試**：`test/enroll.test.mjs` 24 項。
- **未上線**：owner 的 Chrome 重新載入由主控安排；sbd、召喚端的對應實作是其他任務。

## 擴充 0.2.11 — 2026-11-13（`07a7338`，X2O）

**缺陷**：E1-D14（fill 回 `PAGE_BLOCKED step=fill/pageOriginOk dialog_suspected=true value_written=true`）、E1-D14b（閒置數分鐘後 bind 回 `NO_TAB`）。

- **為何**：原先推定是網站對話框或 Claude in Chrome 的除錯連線，都被實測推翻（登入頁沒有任何腳本；加掛除錯連線 fill 仍在 0.3 秒內成功）。根因是 Chrome 對閒置背景分頁的兩種處理：**凍結**（注入排隊到解凍才執行，截圖照常）與**丟棄**（換一個新的分頁 ID，舊 ID 查不到）。發起點二（監督者數分鐘後才召喚）幾乎必中。
- **改了什麼**：
  - 每次注入前看 `chrome.tabs.get().frozen`；凍結就 `chrome.tabs.update({active:true})` 切成所在視窗的作用中分頁（不拉視窗到前景、不搶視窗焦點），最多等 1.5 秒解凍。注入等待中才凍結：叫醒後等原本那次注入，不重送。
  - 叫不醒時 fill、click **不送出**，回 `PAGE_BLOCKED`、`tab_frozen=true`、`dialog_suspected=false`。`PAGE_BLOCKED` 一律附 `tab_frozen`、`tab_discarded`、`tab_active`；喚醒過的成功回覆附 `tab_woken`、`tab_reloaded`、`tab_replaced`（sbd 記進稽核）。
  - `tabs.onReplaced` 記下「舊 ID → 新 ID」（最多 200 筆，存 `storage.session`），指令用舊 ID 也找得到；工作與退過擴充頁的記錄搬到新 ID，保留期直接結束。
  - bind 遇到被丟棄的分頁先重新載入、等載完；工作期間設 `autoDiscardable:false`，結束時還原原本的設定。
- **owner 決策 Q14（已接受）**：凍結時切成該視窗作用中分頁。owner 正在用同一個視窗時會看到分頁突然切換、鍵盤輸入目標改變。
- **D15 沒有放寬**：凍結的分頁 release 照樣導到擴充頁，兩欄都清除。

## 擴充 0.2.10 — 2026-11-12（`ca683a1`，X2N）

**缺陷**：R19-1（已離開的文件從往返快取恢復後，網站在 rAF、計時器或用 inline style 蓋過補上的遮罩，值會露出）。

- **為何**：0.2.9 讓網站內容留在凍結的文件裡、恢復後靠補遮罩和網站賽跑，網站隨時能再改畫面，不會收斂。
- **改了什麼**：
  - 離開時清值、蓋遮罩後，**移除 `documentElement` 底下遮罩以外的網站內容**；框架節點只隱藏不移除（移除卡在原生對話框的跨站子框架會讓分頁卡死，M7）。
  - 已離開的文件從往返快取恢復時，同步蓋遮罩、清內容，再 `location.replace("about:blank")` 取代這一格歷史；背景（`leftTabs` 備援）把 about:blank 換成擴充頁。
- **量測**：六種變形加「網站重建表單回填」，露出 0 次；恢復到被換掉約 1～12 毫秒。

## 擴充 0.2.9 — 2026-11-12（`f70fe34`，X2M）

**缺陷**：R18-1（網站在 pagehide 整理頁面連遮罩一起移除，恢復時露出值）、R18 六項對話框測試回 `PAGE_BLOCKED`。

- 離開前先清空交付過的欄位值；pagehide／pageshow（persisted）時在 ISOLATED world **同步**重建遮罩；遮罩掛在 `documentElement`、樣式 `!important`。（遮罩這一層之後由 0.2.10 的「移除內容＋換成 about:blank」補強。）
- 清理注入連重試都沒回應時，不再做注定卡住的唯讀核對，直接退到擴充頁，把預算留給導頁（0.2.8 在對話框情境約 7.1 秒才開始等導頁，期限只剩約 0.4 秒）。

## 擴充 0.2.8 — 2026-11-12（`6fa878f`，X2L）——清理契約

**缺陷**：R17-1、R17-2、R17-3（核對之後網站又寫回值、掃描範圍外有副本、往返快取恢復）。

- **為何**：R15→R16→R17 連續三輪都是「用等待＋掃描追網站時序」，調時間或加選擇器不會收斂。改成契約：
- **C1**：非 OK、清不乾淨或無法核對 → 分頁導到擴充自己的 `cleared.html`，已提交的網址確實是擴充頁才回 `cleared_by=extension_page`。
- **C2**：`release` 的 `outcome` 只有 `"ok"` 才原地清；缺少或其他值一律 C1。登入成功時核對頂層＋同來源框架＋開放 shadow root＋contenteditable，有值或有看得見的跨來源框架 → C1。
- 移除 0.2.6／0.2.7 的「導回目前網址再核對」與 `verifying`／`touched` 記帳（**已取代**）。
- secret-broker 端：`sb web-login-end` 印 `ENDED_LEFT`，召喚端提醒「這只表示代填資料已清除，不代表登入成功」。

## 擴充 0.2.7 — 2026-11-12（`6d7a212`，X2K）——已被 0.2.8 取代

**缺陷**：R16-1。導回目前網址後，新文件載完並兩次核對都沒有交付值才算清掉，核對完成前新文件有遮罩。整段機制在 0.2.8 移除。

## 擴充 0.2.6 — 2026-11-12（`a784ba0`，X2J）——已被 0.2.8 取代

**缺陷**：R15-1。release 以整份文件的可見表單為準核對交付值（每輪清空、送事件、等 100 毫秒、最多三輪），清不掉就導回目前網址並核對新文件。「每輪清空再掃」保留到 0.2.8 的原地清；「導回目前網址」在 0.2.8 移除。

## 擴充 0.2.5 — 2026-11-12（`57fa1f7`，X2I）

**缺陷**：E1-D15（交付過的值在某些結束路徑沒清）、R14-1（派發與換頁之間打到別份文件）、R14-2（保留期文件的保護歸屬）、E1-D14（fill 逾時誤判）。

- fill 寫入前記下欄位；release 不論 `clear_password` 都清交付過的帳號與密碼欄，晚到也清，清空才移除遮罩；回覆分欄 `username_cleared`、`password_cleared`。
- fill、click、mask 以 `documentIds` 綁定文件派發。
- 保留期文件另記 `guardDocs`，恢復時只還原自己的保護、不授予操作。
- fill／click 記進度，逾時後用唯讀的 `pageProbe` 讀回；新增 `page_responsive`、`value_written` 診斷。

## 擴充 0.2.4 — 2026-11-12（`b9f21c1`，X2H）——單一注入路徑

**缺陷**：R13-1、R13-2、D10、E1-D12（R10～R13 連續四輪都是「頁內副作用沒有核對可信的工作／文件身分」）。

- 會改頁面的注入一律經背景的 `act()`：`pageOp`（ISOLATED，帶工作世代）、`pageGuard`（MAIN，帶保護擁有者）；不符就不動作。
- 可信記錄 `gens`、`docs`；往返快取恢復只清理記錄裡曾屬於工作的文件。
- `state`／`fields` 在導頁中等到約 12.5 秒，仍讀不到回 `NAVIGATING`；release 時分頁還在載入，對話框保護保留到載完再過 3 秒（最長 60 秒）。
- 新增權限 `webNavigation`（只用 `getFrame`）。

## 擴充 0.2.3 — 2026-11-12（`5cbd96f`，X2G）

**缺陷**：R12-1（往返快取恢復）、R12-2（已排程的點擊沒綁工作）、E1-D9（release 被同來源其他分頁卡住）。

- 每次 open／bind 給隨機工作世代；點擊與 fill 執行前核對；pagehide／pageshow（persisted）重判。
- release 只處理工作分頁；沒有副作用的注入逾時後重試一次。

## 擴充 0.2.2 — 2026-11-12（`5f02fc1`）

**缺陷**：E1-D8（指令超過 sbd 的期限）、R11-1（保護依頁面可寫的旗標判定）、R11-2（清密碼過期卻回 ok）。

- click 只排程、立即回覆；每個指令有自己的總期限（release 8 秒、ping 2.5 秒、其他 15 秒），都比 sbd 短。
- `PAGE_BLOCKED` 附 `step`、`tab_status`、`navigating`、`dialog_suspected`。
- 對話框保護改由背景依 `sender.tab`／`sender.origin` 判定，兩支內容腳本以一次性值握手。

## 擴充 0.2.1 — 2026-11-12（`ba48eb7`）

**缺陷**：R10-1（保護影響同來源其他分頁、無法還原）、R10-2（逾時後晚到的副作用、清理失敗仍回 ok）。

- 保護只對工作分頁且可還原；fill、click、清密碼帶頁內期限，晚到就不執行；清理失敗不回 ok。新增 `storage` 權限（只用 `storage.session`）。

## 擴充 0.2.0 — 2026-11-12（`efdd03a`）

**缺陷**：E1 D5（工作分頁被網站對話框卡住，sbd 等不到回覆而斷線）。

- 工作期間關掉網站對話框（alert、beforeunload 視同確定，confirm／prompt 取消）；頁面沒回應回 `PAGE_BLOCKED`；新增 `reload` 指令（`sb ext-reload`）。

## 擴充 0.1.0 — 2026-11-12（`f852653`）

- 新增 secret-broker 登入擴充（MV3），固定 ID `ndkjgdfkblmnafdjlpkaoaocdepopoln`。只接受原生主程式 `com.tung.secret_broker` 的指令：`ping`、`open`、`bind`、`nav`、`fields`、`click`、`state`、`fill`、`release`；來源比對、遮罩、原生 setter 填值。
- 擴充測試的瀏覽器：先用 Chrome for Testing（`ca8549e`），之後改成正版 Google Chrome（`a7804ca`，先過 `codesign --verify`、暫存設定檔、headless、pipe）。

## 已知風險（0.2.11）

只摘要，詳細與處置見 wl 團隊 `BACKLOG.md`「已知風險」：

| 編號 | 摘要 |
|---|---|
| F48（Q2，owner 接受） | 原生主程式的身分沒有綁定，日後改簽章 helper |
| F103 | 網站在 window 捕獲階段攔掉 submit 時，cdp 後端判成未送出（不會誤報成功） |
| F114 | 擴充非正常重新載入後，工作分頁可能維持「不可自動丟棄」，只影響記憶體管理 |
| F115 | 分頁換 ID 超過十段時，舊 ID 找不到最新分頁，回 `NO_TAB`（偏保守） |
| F117 | 剛建立的非作用中分頁在螢幕鎖定時送出沒生效，回 `slow_response`，使用者再試一次 |
| X2N 極短窗口 | 舊文件恢復到換成空白頁之間約 1～12 毫秒，網站刻意對抗時可能短暫顯示；一般整理、回填、重建實測 0 次 |
| 跨來源框架 | 離開時跨來源框架只隱藏，內部值無法抹除；封閉 shadow root 不在核對範圍 |
| 停在空白頁 | 兩條背景路徑都失效時，分頁可能停在 about:blank（不顯示舊內容）；退過的分頁使用者自己開 about:blank 也會被換成擴充頁 |
| Q14（owner 接受） | 凍結時切成作用中分頁，同一視窗的使用者會看到分頁切換 |

---

## 腳本：代登入的 cdp 後端（2026-11-10～11-12）

- `6f94dab`：新增 `browser-fill.js`（值從 stdin 讀、不印出，寫入前後比對網域與長度）、`browser-stop.js`；`PI_BROWSER_PORT`、`PI_BROWSER_PROFILE_DIR` 可設定；`cookies` 預設遮值；`--host` 只操作網址相符的分頁；`PI_BROWSER_DENY`。
- `610ffd5`：headless 自動關閉頁面對話框；`eval`、`screenshot`、`nav` 加整體逾時。
- `c0a1f19`：`browser-fill.js` 加 `--expect-origin`，比對完整來源（scheme＋host＋埠）；`--expect-host` 保留為舊介面。
- sbd 執行 `browser-fill.js` 前比對 `policy.toml` 釘住的 sha256；改了這支腳本要用 `sb login --pin-fill-script` 印出新值，由 owner 寫回設定。
- 這條路徑（:9223 headless Chrome）現在是**備援**：`login-summon.sh --backend auto` 在擴充沒連線時才用。主要路徑是 owner 日常 Chrome 裡的擴充。

## 腳本：其他（2026-09～11）

- `eb90d36`（2026-09-23）：`captcha-live`，辨識目前工作階段裡顯示的驗證碼。
- `5925f95`（2026-11-06）：`start` 預設 headless 不搶焦點（`--headed` 切回）；新增 `view`。

---

## 腳本 v1.1.0 — 2026-06-24（原文保留）


### ✨ New Features

### `--zyte-spm-profile` auto-detection from `--device`

When `--zyte` and `--device` are used together, the SPM profile is now **automatically inferred**:

| `--device` | SPM Profile |
|------------|-------------|
| (none)     | `desktop`   |
| iPhone 15  | `mobile`    |
| Galaxy S9  | `mobile`    |
| iPad Pro   | `mobile`    |
| Desktop    | `desktop`   |

**Before** (confusing):
```bash
pi-browser capture URL --device="iPhone 15" --zyte --zyte-profile=mobile
```

**After** (auto-detected):
```bash
pi-browser capture URL --device="iPhone 15" --zyte
# SPM profile automatically → mobile
```

Explicit override still works:
```bash
pi-browser capture URL --device="iPhone 15" --zyte --zyte-spm-profile=desktop
```

### CLI help prettified

- ANSI colors in terminal (green commands, cyan flags, yellow `--zyte`)
- Colors degrade gracefully when piped
- New `ZYTE PROXY` section in main help listing supported commands

### 🔄 Changed

- `--zyte-profile` renamed to `--zyte-spm-profile` (clearer semantics)
- `--zyte-profile` still works as legacy alias (backward compatible)
- `--zyte-spm-profile` takes precedence when both are present

### ✅ Verified

Full field test against `<預覽站>` — **28/28 passed**:

| Command | Mode | Result |
|---------|------|--------|
| capture | viewport | 1440×900, 599 KB |
| capture | full-page | 1440×3347, 1.5 MB |
| capture | iPhone 15 | 1179×1977, DPR=3, touch=1 |
| capture | .camera_wrap | element crop 1440×576 |
| netlog | all | 40 responses |
| netlog | --min-status=400 | filtered 4xx/5xx |
| netlog | --device | mobile UA |
| slider | Camera | 2 slides |
| slider | Owl | 5 slides |
| captcha | contact page | 200×60 GD-JPEG, iframe intercept |
| zyte | fail-closed | all 4 scripts ✓ |

### 📦 Files Changed

```
zyte-proxy.js        +inferSpmProfile() + --zyte-spm-profile + legacy compat
browser-capture.js   pass device to launchZyte
browser-slider.js    pass device to launchZyte
browser-netlog.js    pass device to launchZyte
browser-captcha.js   help update
bin/pi-browser       ANSI colored help + ZYTE section
SKILL.md             docs sync
```

### 🐛 Known Issues

None.

### 📝 Migration

No breaking changes. `--zyte-profile` continues to work as an alias.
