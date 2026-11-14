# secret-broker 登入擴充（MV3）

secret-broker 代登入的填值端。只接受本機原生主程式 `com.tung.secret_broker`（`sb native-host`，再連到 sbd）的指令，在指定分頁填帳密。介面見 secret-broker `docs/superpowers/specs/2026-11-12-ext-backend-protocol.md` §1。

## 最終狀態（2026-11-13）

- 版本 **0.2.11**（pi-browser-tools `07a7338`）。代登入主線已結案：複審沒有高、中缺陷，發起點一、發起點二（含 auto mode）的完整回歸全部通過。逐版紀錄見上層 `RELEASES.md`，總覽與結果代碼見上層 `README.md` §9。
- **清理約定**：`release` 的 `outcome` 只認 `"ok"`；非 OK、清不乾淨或無法核對一律導到 `cleared.html`（`cleared_by=extension_page`）。離開時移除網站內容；往返快取恢復時換成 about:blank，再由背景換成擴充頁（0.2.8～0.2.10，見下面「清理契約」）。
- **凍結與丟棄的分頁**：注入前發現凍結就切成所在視窗的作用中分頁喚醒（owner 決策 Q14，2026-11-13 已接受）；`tabs.onReplaced` 對照舊 ID → 新 ID；工作期間 `autoDiscardable:false`（0.2.11）。
- **owner 已接受的殘餘**：Q2／F48 原生主程式身分沒有綁定；Q15 接手的代理看得到網站自己顯示的帳號，只要求不轉述。
- **已知風險**（摘要，詳見 wl 團隊 BACKLOG）：F103、F114、F115、F117、X2N 極短窗口、跨來源框架只隱藏、停在空白頁。
- 下面各節照版本順序保留設計理由；被後續版本取代的段落已標「已取代」。

- **擴充 ID（固定）**：`ndkjgdfkblmnafdjlpkaoaocdepopoln`
  - 由 `manifest.json` 的 `key`（RSA 公鑰）決定；未封裝載入就是這個 ID。
  - 產生 key 的私鑰沒有保留：用不到（不打包 .crx、不上架）。要換 ID 就重新產生 key，並同步更新原生主程式 manifest 的 `allowed_origins`。
- **權限**：`nativeMessaging`、`scripting`、`storage`（只用 `storage.session` 記工作分頁與可信記錄）、`tabs`、`webNavigation`（0.2.4 起，只用 `getFrame` 查分頁目前的文件 ID）；主機權限是所有 `http://*/*`、`https://*/*`（owner 選甲）。
- **不提供**：任意 JS、讀 cookie、操作非工作分頁、接受網頁或其他擴充的訊息（沒有 `externally_connectable`、沒有 `onMessageExternal`）。`runtime.onMessage` 只接受本擴充自己的內容腳本，只回答「這份文件要不要保護」。

## 指令

| cmd | 參數 | 回覆 |
|---|---|---|
| `ping` | — | `{ok, version}` |
| `open` | `url, origin` | `{ok, tab}`：背景新分頁（`active:false`），載入完成且來源相符才登記為工作分頁並蓋遮罩 |
| `bind` | `tab, origin` | `{ok}`：把既有分頁（例如 Claude in Chrome 的分頁）登記為工作分頁並蓋遮罩 |
| `nav` | `tab, origin, url` | `{ok}`：只准同來源網址（約定 §4 的 `sb browser nav`） |
| `fields` | `tab, origin` | `{fields:[{selector,type,name,placeholder,label,tag,text,form}]}`，不回任何值 |
| `click` | `tab, origin, selector` | `{ok, scheduled}`：只排程點擊、立即回覆（執行前核對工作世代與期限）；只准 `button`、`input[type=submit]`、`a`、`[role=button]` |
| `state` | `tab, origin` | `{url,title,text,hasPasswordField}`：text ≤ 2000 字，輸入框現值與本次填過的值都換成 `[遮蔽]`；分頁還在導頁或載入而讀不到，等到指令開始後約 12.5 秒仍讀不到就回 `NAVIGATING`（`fields` 相同） |
| `fill` | `tab, origin, selector, field, value` | `{ok, len}`：寫入前後比對來源，原生 setter＋`input`／`change`，只回長度 |
| `release` | `tab, clear_password, outcome` | `{ok, username_cleared, password_cleared, cleared_by}`：照下面的「清理契約（0.2.8）」結束工作。`outcome` 只有 `"ok"`（登入成功）才原地清；缺少或其他值一律退到擴充頁。`cleared_by` = `page`（原地清掉）／`gone`（文件已不在，或換頁後核對沒有交付值）／`extension_page`（分頁已換成擴充頁）。還原對話框保護（原地清理時分頁還在導頁或載入，保護保留到載完再過 3 秒，最長 60 秒）；期限內沒完成回 `PAGE_BLOCKED`（工作仍結束）；不是工作分頁就不動頁面 |
| `reload` | — | `{ok}`：先結束所有工作（結果不明：退到擴充頁；重新載入時 Chrome 會關掉停在擴充頁的分頁），全部成功才回 ok 並在回覆後 `chrome.runtime.reload()`（任一失敗回 `PAGE_BLOCKED`、不重新載入），重新載入後自己重連（secret-broker `sb ext-reload`） |

錯誤：`NAVIGATING`（0.2.4，`state`／`fields`：分頁還在導頁或載入，請再等一次；不是頁面卡住）、`PAGE_BLOCKED`（頁面沒有回應，例如被對話框卡住，或分頁被凍結而叫不醒（0.2.11，附 `tab_frozen=true`）；每次注入最多等 6 秒、整個指令最多 15 秒，比 sbd 的 20 秒短，所以不會讓 sbd 斷線）、`URL_MISMATCH`（分頁來源不符，或是不能注入的頁面）、`NO_TAB`、`NOT_BOUND`（不是工作分頁）、`NO_FIELD`、`FILL_FAILED`、`NO_ELEMENT`、`NOT_CLICKABLE`、`BAD_ARGS`、`UNKNOWN_CMD`、`INTERNAL`。

## 會改頁面的注入只有一條路（0.2.4，X2H：R10～R13 的結構性修法）

R10～R13 連續四輪都在「頁內副作用沒有核對可信的工作／文件身分」這一類缺陷上出問題（晚到填值、排程點擊、快取恢復、清理重試、非工作文件被清）。0.2.4 起所有會改頁面的注入都經背景的 `act()`，頁面只跑兩個包裝函式：

- `pageOp`（ISOLATED world）：claim、mask、fill、click、release。攜帶目標工作世代 `gen`，動手前先核對這份文件的世代：
  - 進行中的操作（mask、fill、click）：文件目前世代要等於 `gen`。從未被任何工作接手的文件由背景確認後先 claim。
  - 清理（release）：文件曾屬於 `gen`，而且沒有被新工作接手。
  - 不符就什麼都不做，回 `{stale:true}`。世代只存在擴充的 ISOLATED world，頁面讀不到。
- `pageGuard`（MAIN world）：對話框保護的安裝（on）與還原（off）。攜帶保護擁有者 `guardId`（另一個隨機值），擁有者記在閉包裡；擁有者不符的還原不動作。
- 可信記錄（背景，記憶體＋`storage.session`）：`gens`（世代 → 擁有者、release 當時的 `clear_password`）與 `docs`（文件 ID → 世代，只記工作真的接手過的文件）。往返快取恢復時只看 `docs`，從未屬於工作的文件什麼都不清（R13-1）。
- 效果：逾時後才執行的第一次嘗試、重試、舊工作的清理都會落空，碰不到新工作（R13-2）；不靠期限，也不靠取消注入。

| 注入點 | 0.2.3 | 0.2.4 | 0.2.5（X2I） |
|---|---|---|---|
| fill | `pageFill`（只在文件沒世代時採用） | `pageOp("fill")`：核對世代 | 派發前先查文件 ID、記成「可能動過」並綁定該文件派發；寫入前記下欄位（release 一定清）；記進度，逾時後 `pageProbe` 讀回 |
| click 與排程的點擊 | `pageClick` | `pageOp("click")`：預檢＋點擊前再核對世代 | 同上（可能動過、綁定文件、記進度） |
| 遮罩（open、bind、nav、換頁後） | `pageMaskOn`，沒有身分核對 | `pageOp("mask")`：核對世代 | 同上（可能動過、綁定文件） |
| bind／open 接手文件 | `pageLifecycle` | `pageOp("claim")`：並記入可信記錄 | 不變（不改畫面；補接手時綁定同一份文件） |
| release 清值、移除遮罩 | `pageRelease`，沒有世代 | `pageOp("release")`：核對文件曾屬於這個工作 | 清掉交付過的每個欄位、晚到也清、清空才移除遮罩。**0.2.8**：只在登入成功時原地清；核對範圍擴大到同來源框架、開放 shadow root、contenteditable；清不乾淨或無法核對就退到擴充頁（`pageOp("leave")`，步驟 `pageLeave`）。唯讀核對是 `pageOp("check")`（步驟 `pageCheck`） |
| 還原保護（release、保留期結束、恢復、啟動清理） | `pageGuardOff`，沒有擁有者 | `pageGuard("off")`：核對擁有者 | 另外：保留期文件恢復時依 `guardDocs` 的擁有者還原 |
| 安裝保護（bind、恢復後新工作接手） | `pageGuardOn` | `pageGuard("on")`：設定擁有者 | 不變 |
| 往返快取恢復後的清理 | `pageRelease`＋`pageGuardOff`（gen 為空也清） | 只有 `docs` 記錄裡的文件，用它那個工作的世代與擁有者 | 工作文件同 0.2.4；保留期文件（`guardDocs`）只還原保護、不授予操作 |
| 內容腳本的保護判定 | `dialog-guard.js` 的 `guard()`／`restore()` | 判定帶擁有者；`restore(擁有者)` 不符不動作 | 保留期的判定同時記下文件 → 擁有者（`guardDocs`） |
| 進度讀取 `pageProbe` | — | — | 唯讀：只讀 fill／click 自己記的進度（代碼與長度，沒有值） |

讀取類注入（`pageState`、`pageFields`、`pageOriginOk`、`pageFrameOrigin`、`pageProbe`）不改頁面，不經包裝（`pageState` 讀文字時會暫時隱藏再恢復遮罩）。

## 「可能動過」與交付過的值（0.2.5，X2I：R14-1、E1-D14、E1-D15）

- **綁定文件派發（R14-1）**：fill、click、mask 派發前就用 `webNavigation.getFrame` 查目標文件 ID，並以 `documentIds` 綁定這份文件派發（查詢與注入之間換頁也打不到別份）。fill 派發時記下「填值的文件」（`job.filled`），release 用它分辨 C2(b)／C2(c)。0.2.8 起不再記「可能動過」（`touched`）：release 一律以核對目前文件或退到擴充頁為準。
- **交付過的值一律清（E1-D15、R15-1）**：
  - fill 寫入前在 ISOLATED world 記下欄位（`WeakRef`）與交付值（頁面讀不到）。背景也把交付值帶到 release。
  - release 不論 `clear_password` 都清，晚到也清（已核對這份文件屬於這個工作），回覆照實報當下的結果。
  - 原地清（登入成功、填值的文件還在）：每一輪在核對範圍內把含交付值的欄位清空，下一個 task 才送 `input`／`change`，等 100 毫秒，再重新掃；最多三輪。值只在 ISOLATED world 比對，不回傳。掃完確定乾淨才移除遮罩。
  - 比對規則：欄位值等於交付值，或交付值至少 6 字而欄位值包含它。
  - 0.2.6～0.2.7 的「清不掉就導回目前網址、核對新文件、核對中記錄（verifying）」已整段移除，改由下一節的清理契約處理。

## 清理契約（0.2.8，X2L：R17-1、R17-2、R17-3）

R15→R16→R17 連續三輪都是「核對時間點之後網站又寫回值」或「掃描範圍外有副本」：再調等待時間或加選擇器不會收斂。0.2.8 起不追網站的時序，改成這份契約（主控的可回復假設，owner 之後可改）：

- **C1 退路＝離開網站內容**：把工作分頁導到擴充自己的頁面 `cleared.html`（`chrome.tabs.update` 到 `chrome-extension://…`，不需要 `web_accessible_resources`）。頁面只顯示「已清除代填資料」、站名與「回到登入頁」按鈕；按鈕是使用者自己的動作，回到綁定時的網址（來源＋路徑，不含查詢字串），擴充不會再填值。分頁已提交的網址確實變成擴充頁才回 `cleared_by=extension_page`：網站內容已不在畫面上，沒有時序與範圍的問題。
  - 離開的文件先蓋遮罩（工作文件本來就有，不移除）並記進可信記錄；它從往返快取恢復時，畫面先是凍結前就在的遮罩（不靠背景往返，R17-3），背景收到 `pageshow` 再退一次擴充頁。
  - 期限內換不成擴充頁就照實回 `PAGE_BLOCKED`（`step=release/tabs.update`）。舊文件主執行緒忙時（保護掛著 `beforeunload`），導頁要等它空出來；已送出的導頁之後會提交。
- **0.2.9（X2M，R18-1 與 R18 的六項對話框失敗）**：
  - 離開前先清空交付過的欄位值（不送事件），並在 ISOLATED world 記下「已離開」（`__sbLeft`）。
  - 往返快取：曾屬於工作而且沒有被原地清乾淨的文件（`__sbDocGen` 有值、`__sbClean` 不是真）或已離開的文件，pagehide 與 pageshow（persisted）時**同步**重建遮罩，下一個畫面前再確認一次；不等 `sendMessage` 的回覆。網站在 pagehide 整理頁面（`body.replaceChildren`，甚至移除 `documentElement` 底下 head／body 以外的節點），恢復時畫面也先是遮罩，背景再退一次擴充頁。只限工作分頁的文件：其他文件沒有這兩個旗標。
  - 遮罩一律掛在 `documentElement`，樣式全部 `!important`（pageOp 的 `sbMask` 與 `dialog-guard-check.js` 的同名函式要一起改）。
  - 不讓離開的文件進往返快取：沒有擴充能控制、又沒被淘汰的可靠方法（`unload` 已淘汰；`Cache-Control: no-store` 由網站決定；Web Locks 等阻擋條件 Chrome 一直在放寬），所以不採用，改用上面的同步遮罩。
  - 清理注入連重試都沒回應（對話框、長任務）：唯讀核對也一定卡住，直接退到擴充頁，不再先等 1 秒核對、0.5 秒蓋遮罩（離開前的注入照樣送出，不等它）。0.2.8 在對話框情境要約 7.1 秒才開始等導頁提交，只剩約 0.4 秒；負載高時來不及，回 `PAGE_BLOCKED`、`step=release/tabs.update`、`navigating=true`（R18 的六項）。對話框不會擋住導頁：Chrome 換頁時會關掉它，所以不必先關或接受對話框。
- **0.2.10（X2N，R19-1）**：0.2.9 靠「恢復時補遮罩」對抗網站整理頁面，網站在 rAF、計時器或用 inline style 蓋住遮罩時仍會露出值。改成不讓離開的文件留下可以顯示的東西，而且一恢復就把它換掉：
  - 離開時（leave）清值、蓋遮罩之後，**移除 `documentElement` 底下除了遮罩以外的所有網站內容**（`wipe`）。框架節點（`iframe`／`frame`／`object`／`embed`）不移除，改成 `display:none !important`，同來源框架往裡面繼續清：移除正跳著原生對話框的跨站子框架會讓分頁卡死（M7）。已離開的文件在 pagehide（persisted）時再清一次。
  - 已離開的文件從往返快取恢復（pageshow persisted 且 `__sbLeft`）：同步蓋遮罩、清內容，再**同步 `location.replace("about:blank")`**，這一格歷史被取代，再按上一頁也回不到舊文件。內容腳本不能直接 replace 到擴充頁（會變成 `chrome-extension://invalid/`），所以由背景負責：退過擴充頁的分頁記在 `leftTabs`（存進 `storage.session`，service worker 重新啟動後載回），`tabs.onUpdated` 看到它變成 `about:blank` 而且沒有新工作，就再退一次擴充頁。新工作 open／bind 接手或分頁關閉時移除記錄。
  - 量測（真實 Chrome，R19 的六種變形加「網站用 JS 重建新表單並回填」）：恢復到被換掉約 2～12 毫秒、0～2 個畫面，露出 0 次。網站的 pageshow 監聽比我們早掛（bind 既有分頁）時窗口較長，但畫面上只有遮罩，網站重建的表單也會在同一輪被換掉。
- **C2 什麼時候退**：
  - (a) 登入沒有成功（`outcome` 不是 `"ok"`，未知也算）：不原地清，一律 C1。失敗頁常由伺服器帶回帳號預填，而且失敗時 Claude 依技能也不接手那個分頁。
  - (b) 登入成功、填值的文件還在：原地清後，在核對範圍內核對。仍有值、contenteditable 含交付值（不改網站的內容）、或有看得見的跨來源框架（讀不到內容）→ C1。
  - (c) 登入成功、填值的文件已換掉（正常登入後換頁）：只核對新文件核對範圍內的欄位值；畫面文字顯示帳號名（例如「歡迎 xxx」）不算（F60）。有值、無法核對、沒回應 → C1。
- **核對範圍**：頂層文件＋同來源框架（遞迴）＋開放的 shadow root 裡的 `input`／`textarea`（非 hidden），以及 `contenteditable` 區域的文字。看得見（有大小）的跨來源框架記成無法核對；0×0 的跨來源框架（追蹤像素等）不影響。封閉的 shadow root 讀不到，不在範圍內。
- **其他結束路徑**：`reload` 與 service worker 重新啟動後的清理都是結果不明，一律 C1。open／bind 自己失敗時（還沒交付任何值）原地清理，不把分頁導走。
- **取捨**：
  - 登入成功但頁面有看得見的跨來源框架（廣告、驗證碼、嵌入影片），或新首頁主執行緒一直忙，都會退到擴充頁或照實回失敗；Claude 之後重新開網址即可（登入狀態由 cookie 保留）。
  - 原地清掉之後，網站在同一份文件裡晚到的回填，不在保證範圍內（成功路徑才會原地清，失敗路徑不會留在網站上）。
  - 擴充重新載入時，Chrome 會關掉停在擴充頁的分頁。

- **被 Chrome 凍結的分頁（0.2.11，X2O，E1-D14）**：背景分頁閒置幾分鐘後、或螢幕鎖定時，Chrome 會凍結分頁：注入排隊到解凍才執行，截圖照常，0.2.10 以前和對話框分不出來（現場的 `step=fill/pageOriginOk dialog_suspected=true value_written=true`，用 CDP `Page.setWebLifecycleState frozen` 可完全重現）。
  - 每次注入前用 `chrome.tabs.get` 看 `frozen`：被凍結就把它切成所在視窗的作用中分頁（`chrome.tabs.update({active:true})`，不搶視窗焦點），最多等 1.5 秒解凍。先送輕量注入叫不醒它（實測）。
  - 注入等待中才被凍結（寫值後的來源檢查）：叫醒後等原本那次注入回來，不重送。
  - 喚醒過的指令回覆帶 `tab_woken=true`（sbd 記進稽核）。
  - 叫不醒（作用中分頁也被凍結，例如螢幕鎖定）：fill、click **不送出**（值不寫進不會回應的文件，解凍後也不會晚寫），回 `PAGE_BLOCKED`、`tab_frozen=true`、`dialog_suspected=false`。PAGE_BLOCKED 一律帶 `tab_frozen`、`tab_discarded`、`tab_active`。
  - release 不變：凍結的分頁照樣導到擴充頁（實測約 5.6 秒，兩欄都清除），D15 的清理保證沒有放寬。
- **被 Chrome 丟棄的分頁（0.2.11，X2O，E1-D14b）**：閒置的背景分頁被丟棄時，Chrome 用**新的分頁 ID** 取代它（`tabs.onReplaced`），舊 ID 從此查不到，bind 就回 `NO_TAB`。呼叫端手上只有舊 ID（Claude in Chrome 事後仍列得出那個分頁）。
  - 背景記下替換對照（舊 ID → 新 ID，存 `storage.session`）。每個指令先依對照換成目前的 ID，回覆帶 `tab_replaced=true`。進行中的工作、退過擴充頁的記錄、保留期也跟著搬到新 ID。
  - bind 遇到被丟棄的分頁：先 `chrome.tabs.reload` 並等它載完才綁定，回覆帶 `tab_reloaded=true`。這時還沒交付任何值，重新載入只會清掉 Chrome 自動填入的內容；遮罩與 D15 清理照常套在新文件上。實測不重新載入時，Chrome 也會在注入時自己把分頁載回來，重新載入只是讓 bind 先等到載完。
  - 工作期間把工作分頁設成 `autoDiscardable: false`，結束（release、啟動清理）時還原原本的設定；原本就不可丟棄的維持不變。
  - 已知現象：背景分頁重新載入後，`tabs.get` 的 `discarded` 仍可能是 true（實測），所以診斷裡的 `tab_discarded` 只是參考。
- **fill 回覆逾時（E1-D14）**：在指令期限內（指令開始後 12 秒）用 `pageProbe` 讀進度。這次 fill 已完成（例如網站的 input 處理程式同步忙很久），就照實回結果；頁面有回應但這次操作沒執行，回 `PAGE_BLOCKED`＋`page_responsive=true`、`dialog_suspected=false`；一直沒回應才是 `page_responsive=false`、`dialog_suspected=true`。這時是對話框、除錯器暫停或很長的同步工作，擴充分不出來。
  - fill 寫入成功、之後的來源檢查才卡住（`step=fill/pageOriginOk`），回覆帶 `value_written=true`。
- **除錯器**：只是掛著 CDP 除錯器（Claude in Chrome 截圖、讀頁）不影響注入；除錯器把 JS 暫停（斷點、`Debugger.pause`）時整頁沒有回應，和對話框一樣處理。

## 保留期文件的保護歸屬（0.2.5，R14-2）

保留期內新文件的詢問只得到保護、不得到世代。背景另外記 `guardDocs`（文件 ID → 擁有者），和可操作的 `docs` 分開，也存在 `storage.session`。這份文件進往返快取、保留期結束後才回來時，依這份記錄只還原它自己的保護（帶擁有者，碰不到新工作的保護），不授予 fill／click／mask。分頁上已有同來源的新工作時，還原後由新工作接手。保留期還在時回來，就維持保護。服務工作者重新啟動後，記錄從 `storage.session` 接回。

## 導頁中與頁面忙（0.2.4，D10、E1-D12）

- **state／fields**：注入逾時而分頁還在導頁或載入（新首頁還在載入，或主執行緒被長請求占住），繼續重試到指令開始後約 12.5 秒；仍讀不到就回 `NAVIGATING`，不當成頁面卡住。pi 擴充收到後會自動再等兩次，仍在導頁就請模型等一下再讀；連續三次才停止（`page_blocked`）。
- **release 時分頁沒有回應**：無法核對，依清理契約退到擴充頁（0.2.8）；導頁要等主執行緒空出來，期限內沒換成就照實回 `PAGE_BLOCKED`。
- **保留期**：release 時分頁還在導頁或載入，遮罩與密碼照常立刻清，對話框保護保留到分頁載完再過 3 秒，最長 60 秒。這段期間這個分頁新文件的 alert 會被擋下：登入後的首頁常一載入就跳 alert，若馬上還原保護，原生對話框會把分頁卡住（主控在有畫面 Chrome 看到 renderer 凍住）。保留期只保護、不給世代，新文件不會被蓋遮罩或操作。
  - 新工作 bind 這個分頁：保留期結束，保護改由新工作持有。分頁關閉或 `reload`：保留期立即結束。service worker 重新啟動：啟動清理會還原。
  - **之後使用者自己重新整理首頁**（沒有工作、沒有保護）：網站原本的 alert 照常跳出，和沒裝擴充時一樣，要按確定。對話框開著時，Claude in Chrome 之類的工具無法操作這個分頁，這是網站本身的行為。
  - 首頁有永遠載不完的資源（分頁一直是 loading）：保護最多保留 60 秒，之後還原；之後才跳的 alert 是原生的。

## 對話框（E1 D5、D9、R10-1、R10-2、R11-1、R11-2、R12-1、R12-2）

- **哪些文件受保護，只由背景的工作狀態決定（R11-1）**：
  - 工作期間，對工作來源註冊 `dialog-guard.js`（MAIN）與 `dialog-guard-check.js`（ISOLATED），兩者都是 `document_start`、所有框架。
  - 每份文件一開始是「待定」：alert 先排隊、confirm／prompt 回取消、beforeunload 也擋。
  - check 腳本向背景詢問；背景用 `sender.tab` 與 `sender.origin`（頁面改不了），比對記憶體裡的工作分頁，回答 guard 或 native。
    - guard：維持保護。
    - native：完全還原原生函式，排隊的 alert 補跳出來。
    - 背景 3 秒內沒回答也還原。
  - 判定經 DOM 事件傳給 MAIN 腳本。兩支腳本在頁面程式執行前先用一次性隨機值握手，頁面偽造的事件一律不理。頁面可寫的狀態（例如 sessionStorage）不再參與判斷。
  - **取捨**：非工作分頁在載入的頭幾毫秒（等背景回答）也會先擋。期間的 alert 會補跳；confirm／prompt 會回取消，這是殘餘影響。
- **bind 的立即安裝**：先查每個框架的實際來源（`self.origin`），只對相符的框架注入，注入函式內再核對一次。about:srcdoc 這類繼承來源的框架，由上層文件遞迴處理。跨來源 iframe 完全不動。
- **行為**：對齊 :9223 的 pi-browser：alert 與 beforeunload 視同確定，confirm／prompt 取消。
- **還原**：
  - release、reload 只處理工作分頁本身（0.2.3，E1-D9）：從頂層框架遞迴到同來源的子框架呼叫 `restore()`，不用 `allFrames`，不再掃同來源的其他分頁。別的分頁卡住（例如留著一個開著的對話框）不會讓 release 失敗。
  - 分頁關閉、service worker 重新啟動後的清理，仍會盡力還原同來源的非工作分頁，失敗不回報。
  - 已被頁面存下的函式參考也會恢復原生行為。工作分頁與 release 記錄放在 `chrome.storage.session`（`storage` 權限只用在這裡）。
- **往返快取（R12-1）**：
  - 文件進往返快取（`pagehide`，`persisted`）時，工作世代先失效。
  - 從往返快取恢復（`pageshow`，`persisted`，只認瀏覽器發的事件）時，向背景重判。工作還在就接回世代；工作已結束（或 service worker 重新啟動後工作已不在）就只對這份文件（`documentId`）收尾：照 release 當時的 `clear_password` 清密碼欄（不知道就清）、移除遮罩、還原對話框。
    - **已取代（0.2.8～0.2.10）**：退過擴充頁的文件（`__sbLeft`）恢復時不再收尾後留著，而是同步蓋遮罩、移除內容、`location.replace("about:blank")`，背景再換成擴充頁；見「清理契約」的 0.2.10 段。
- **工作世代（R12-2）**：
  - 每次 open／bind 給工作一個隨機世代，只放在擴充的 ISOLATED world，頁面讀不到也改不了。
  - `click` 排程的點擊在執行前核對世代、頁內期限、元素還在文件裡、沒被停用；`fill` 寫入前也核對世代。
  - release 的第一步是讓世代失效，之後已排程的點擊一律不執行；重新 bind 換新世代，舊工作的點擊也失效。
- **期限（E1-D8）**：
  - 每個指令有自己的總期限，都比 sbd 對該指令的等待短：`release` 8 秒（sbd 的 end 等 10 秒）、`ping` 2.5 秒（sbd 3 秒），其他 15 秒（sbd 20 秒）。
  - 每次注入最多等 6 秒；`release` 的兩步（清值與遮罩、還原保護）並行，先等 4 秒，逾時重試 1.5 秒，仍不行就直接退到擴充頁（0.2.9：沒回應時不做唯讀核對；等分頁換成擴充頁，最多到預算結束前 0.5 秒），都在 8 秒內。
  - **重試（E1-D9）**：讀取、來源檢查、遮罩與 release 的兩步逾時後再試一次（release 等 1.5 秒、其他等 3 秒）。這些操作都核對身分，重做無害。頁面只是短暫忙碌（長任務、慢 script）時重試就成功，不報 PAGE_BLOCKED。`fill`、`click` 不重試。
  - 讀取類注入用 `injectImmediately`，頁面一直載入不完也讀得到。
  - `click` 只排程點擊、立即回覆，不等導頁或對話框。
- **PAGE_BLOCKED 診斷**：回覆帶 `step`（卡在哪一步，例如 `state/pageState`）、`tab_status`（loading／complete／unknown）、`navigating`、`dialog_suspected`（注入連重試都逾時、分頁已完成而且沒有在導頁；只是忙的話重試會成功，不會走到這裡）。`release` 另帶 `mask_removed`、`username_cleared`、`password_cleared`。同一份診斷寫進擴充 log（`console.warn`），不含頁面內容、網址或值。
- **逾時不等於取消**：`fill`、`click` 帶頁內期限（背景時鐘給的），晚到執行就什麼都不做。
  - `release` 的清除**沒有期限**（0.2.5 起，E1-D15）：晚到也清，因為清掉的只是這個已結束的工作交付的值，而且先核對文件屬於這個工作。回覆照實報當下的結果：當下沒清掉就回 `PAGE_BLOCKED`，不回 ok（R11-2 的不誤報仍成立）。
  - `release`／`reload` 任何清理失敗都不回 ok；`reload` 此時不重新載入。
- **殘餘風險**：
  - 頁面在綁定前就存下的原生 `alert`、或工作開始前已跳出的對話框，保護管不到。這時指令回 `PAGE_BLOCKED`＋`dialog_suspected`，晚到的副作用不會執行。
  - 被別的網站嵌入的工作來源 iframe 不在還原範圍：只查頂層網址是工作來源的分頁。

## 補登（0.3.0，設計 secret-broker `docs/superpowers/specs/2026-11-13-webcred-enroll-design.md` §3）

owner 在補登分頁自己登入一次，擴充在送出那一刻把帳密交給 sbd；sbd 另外驗證通過才記下。擴充這端只負責記錄、轉送與清理。

- **指令**：`enroll_bind {tab, origin, enroll, gen, deadline}`、`enroll_open {url, origin, enroll, gen, deadline}`、`enroll_stop {tab, enroll}`（回 `captures_sent`）、`enroll_release {tab, enroll, mode:"clean"|"leave", values?, outcome?}`（回 `cleared_by=page|extension_page|gone`）、`enroll_end {tab, enroll}`、`enroll_end_all {}`。`deadline` 是 epoch 毫秒。
- **事件**（擴充主動送，沒有 `id`）：`enroll_capture`、`enroll_cancel_clicked`、`enroll_tab_event`（`kind` 是 `closed`、`left_origin`、`replaced`）、`enroll_restart_report`。
- **內容腳本** `enroll-capture.js`（ISOLATED world）：既有文件由 `enroll_bind` 注入，之後的導航由動態註冊的 `document_start` 腳本涵蓋；每份文件向背景詢問授權，背景只看 `sender`。
  - 只認可信的點擊送出鈕與在表單欄位按 Enter；`requestSubmit`、`form.submit()`、合成事件都不算。
  - 依 HTML 規則找有效提交者與 action，跨來源、降級、`dialog` 都不產生嘗試。
  - 值在動作當下同步讀取，用 ISOLATED world 自己的原型 getter；送出後丟掉，不進 console、不進 storage。
- **提示列與徽章**：頂層文件畫提示列（closed shadow root；只有「取消補登」接收滑鼠事件，其餘點擊穿過到頁面）；擴充圖示加徽章「補」，標題列出來源，http 加「未加密」。不蓋遮罩、不攔對話框。
- **分頁所有權**：補登分頁收到 `bind`、`nav`、`release` 回 `BUSY`；代登入工作分頁或保留期分頁收到 `enroll_bind` 回 `BUSY`；`fill`、`click`、`state`、`fields` 回 `NOT_BOUND`。
- **斷線**（sbd 重啟、原生主程式結束、service worker 重啟、`reload`）：停止所有補登的捕獲；捕獲過的分頁自行退到 `cleared.html`。`storage.session` 只記分頁、補登 id、來源、是否捕獲過，不記值。每次連上都送一次 `enroll_restart_report`（35 分鐘內），由 sbd 去重。
- **停止的收斂**（0.3.1，R27-1）：`enroll_stop` 先讓每份文件送出延遲中的捕獲、回報讀到的嘗試數，等收到的數目追上才停收；回 `{captures_sent, complete}`。`captures_sent` 是讀到的數目（含沒送達的，無法確認時至少多 1），`complete=false` 時 `enroll_release` 不原地清理。轉送過的值在記憶體留加鹽雜湊，sbd 給的清理集沒涵蓋就不原地清。
- **去重**（0.3.1，R27-4）：只有 Enter 的隱式提交衍生的點擊（detail=0、同一表單、Enter 放開前）不另算；其他可信點擊與 Enter 一律是新嘗試，不看時間間隔。
- **轉送順序**（0.3.2，R28-1）：每個補登工作在捕獲入口同步入列（上限 16），依到達順序逐筆完成驗證、雜湊與轉送；超過上限的丟棄並在停止時判不完整。停止收斂會等已入列的捕獲。控制事件不經這條佇列。
- 測試：`test/enroll.test.mjs`（§8.2 E1～E15、§8.3 可在本機做的部分、R27-1／R27-4、R28-1）。

## 安裝（owner 的日常 Chrome）

1. Chrome → `chrome://extensions` → 開「開發人員模式」→「載入未封裝項目」→ 選這個 `extension/` 目錄。確認 ID 是上面那個。
2. 安裝原生主程式 manifest：`sb native-host install --extension-id ndkjgdfkblmnafdjlpkaoaocdepopoln`（secret-broker）。
3. `sb ext-status` 應回 `CONNECTED <manifest 的版本>`。
4. 之後改了擴充：`sb ext-reload`（0.2.0 起才有 `reload` 指令；從 0.1.0 升級那一次要在 `chrome://extensions` 手動按重新載入）。

## 測試

`node --test --test-timeout=120000 test/extension.test.mjs`（0.2.11：118 項）：用正版 `/Applications/Google Chrome.app`（先過 `codesign --verify`；暫存設定檔、headless、pipe＋CDP `Extensions.loadUnpacked`）載入未封裝擴充，在暫存設定檔的 `NativeMessagingHosts/` 放假原生主程式（`test/extension/fake-host.mjs`），測試程式扮演 sbd。不碰使用者的 Chrome。

`reload：回 ok 後重新載入擴充…` 必須是最後一項：它會重新載入擴充，排在後面的測試會連到已失效的 service worker 而逾時。模擬方法與心得見上層 `TESTING.md`「代登入的測試」。
