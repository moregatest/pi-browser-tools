// secret-broker 登入擴充的背景程式（MV3 service worker）。
//
// 唯一的指令來源是原生主程式 com.tung.secret_broker（sb native-host → sbd）。
// 網頁與其他擴充送不了指令：manifest 不開 externally_connectable，沒有 onMessageExternal。
// runtime.onMessage 只接受本擴充自己的內容腳本（dialog-guard-check.js 與 pageOp 掛的生命週期監聽），
// 只回答「這份文件要不要保護」與「從往返快取恢復後怎麼辦」，訊息內容不帶任何授權。
// 指令（介面約定 §1）：ping、open、bind、nav、fields、click、state、fill、release，另加 reload（重新載入擴充）。
// 0.3.0 補登（設計 2026-11-13-webcred-enroll-design.md §3）：enroll_bind、enroll_open、enroll_stop、enroll_release、
// enroll_end、enroll_end_all；擴充主動送的事件（沒有 id）：enroll_capture、enroll_cancel_clicked、enroll_tab_event、
// enroll_restart_report。補登分頁不蓋遮罩、不攔對話框，只畫提示列與徽章；補登分頁與代登入工作分頁互斥（BUSY）。
// 每則帶 id，回覆帶同一個 id。每個操作分頁的指令都在同一次注入裡先比對 location 的協定與 origin，不符回 URL_MISMATCH。
// 不提供任意 JS、不讀 cookie、不讀非工作分頁；fill 只回長度，不回值。
//
// ==== 會改頁面的注入只有一條路（X2H，R10～R13 的結構性修法） ====
// fill、click、遮罩、release 清密碼／移除遮罩、對話框保護的安裝與還原、往返快取恢復後的清理，
// 一律經背景的 act()，在頁面只跑兩個包裝函式：
//   - pageOp（ISOLATED world）：攜帶目標工作世代 gen。先核對這份文件目前的世代再動手：
//       工作進行中的操作（mask、fill、click）要求文件目前世代 === gen；
//       清理（release）要求文件曾屬於 gen（__sbDocGen === gen）而且沒有被新工作接手（目前世代是 gen 或已失效的 null）。
//       不一致就什麼都不做，回 { stale:true }。世代只存在擴充的 ISOLATED world，頁面讀不到也改不了。
//   - pageGuard（MAIN world）：攜帶目標工作的保護擁有者 guardId（另一個隨機值，不是 gen）。
//       還原只對擁有者相符的保護生效；安裝或接手時改成新擁有者。擁有者記在閉包裡，晚到的舊還原不會撤銷新工作。
//       guardId 頁面看得到（判定事件），但它只是「這份保護屬於誰」的標籤，背景從不接受頁面給的任何值。
// 晚到的注入（逾時後才執行的第一次嘗試、重試、舊工作的清理）因此都會落空，不靠期限也不靠取消。
//
// 可信記錄（背景，記憶體＋storage.session）：
//   gens：gen → { guardId, origin, home, clear, inPlace }（clear 是 release 當時的 clear_password；
//         inPlace：登入成功、原地清理過；否則恢復時再退到擴充頁；最多 100 筆）
//   docs：documentId → gen（只有工作真的接手過的文件：claim 注入的結果、內容腳本詢問時判定 guard 的文件；最多 300 筆）
// 往返快取恢復時只看 docs：查不到就是從未屬於工作的文件，什麼都不做（R13-1）。
//
// 期限（D5、R10-2、E1-D8）：每個指令有自己的總期限（release 8 秒，因為 sbd 的 end 只等 10 秒；其他 15 秒，sbd 等 20 秒），
// 每次注入最多等 PAGE_WAIT_MS。逾時回 PAGE_BLOCKED，附診斷（卡在哪一步、tab.status、是否導頁中、是否疑似對話框），
// 不含頁面內容與值，同時寫進擴充 log。fill、click、清密碼另帶頁內期限，晚到就不動作。
// 讀取類注入用 injectImmediately：頁面一直載入不完（圖片、慢的 script）也讀得到。
// 重試（E1-D9）：讀取與有世代核對的清理逾時後再試一次；第二次也逾時才標 dialog_suspected。fill、click 不重試。
// release 只處理工作分頁本身，不掃同來源的其他分頁。
// release 的清理契約（0.2.8，X2L）見 cleanTab 前的說明：登入沒成功、清不乾淨或無法核對，一律把分頁導到擴充頁 cleared.html。

const HOST = "com.tung.secret_broker";
const MASK_ID = "__sb_login_mask__";
const GUARD_PREFIX = "sb-dialog-";             // 本擴充所有動態註冊的前綴
const PAGE_WAIT_MS = 6000;                     // 一次注入最多等多久
const RETRY_WAIT_MS = 3000;                    // 逾時後重試再等多久
const THAW_WAIT_MS = 1500;                     // 分頁被凍結時，切成作用中分頁後最多等多久解凍（E1-D14）
const RELEASE_WAIT_MS = 4000;                  // release 的注入（遮罩與還原並行；清理本身會等網站同步，最多約 0.3 秒）
const RELEASE_RETRY_MS = 1500;                 // release 重試再等多久
const CHECK_WAIT_MS = 1000;                    // 登入成功、文件已換掉時，唯讀核對目前文件等多久（沒回應就退到擴充頁）
const LEAVE_MASK_MS = 500;                     // 退到擴充頁前，替離開的文件蓋遮罩最多等多久（沒回應就直接導走）
const LEAVE_MARGIN_MS = 500;                   // 等分頁換成擴充頁，最多到指令預算結束前多久
const PAGE_DEADLINE_MARGIN_MS = 1500;          // 頁內期限比等待期限早，及時執行的結果一定回得來
const LOAD_WAIT_MS = 8000;                     // open 等第一份文件載入
const NAV_WAIT_MS = 5000;                      // nav 等載入（之後的讀取用 injectImmediately，不必等到完成）
const COMMAND_BUDGET_MS = 15000;               // sbd 等一般指令 20 秒
const BUDGET_MS = { release: 8000, ping: 2500 };  // sbd 的 end 等 release 10 秒、ext-status 等 ping 3 秒
const NAV_READ_MS = 12500;
const PROBE_UNTIL_MS = 12000;                  // fill／click 回覆逾時後，探進度最多到指令開始後多久（預算 15 秒）                     // state／fields 遇到分頁還在載入時，最多等到指令開始後多久（預算 15 秒）
const GENS_LIMIT = 100;
const DOCS_LIMIT = 300;
// home：「回到登入頁」的網址；delivered：交付過的值（release 時帶到清理）
const jobs = new Map();  // tabId → { origin, values: Set<string>, home, gen, guardId, delivered?, filled?: Set<documentId> }
const gens = new Map();  // gen → { guardId, origin, home, clear?, inPlace? }
const docs = new Map();  // documentId → gen
// 保留期文件的保護歸屬（R14-2）：documentId → { guardId, origin }。只用來還原保護，不授予任何操作（沒有世代）
const guardDocs = new Map();
// 保留期（D10）：release 時分頁還在導頁或載入，對話框保護保留到分頁載完再過 LINGER.grace（最長 LINGER.max）。
// tabId → { origin, guardId, gen, until, timer }。保留期間這個分頁新文件的詢問一樣回 guard（不給世代：不能蓋遮罩或操作）。
const lingers = new Map();
// 退過擴充頁的分頁（0.2.10，R19-1）：tabId → { origin, gen, guardId, home }。離開的舊文件從往返快取恢復時，
// 內容腳本同步把它換成 about:blank；背景看到這個分頁變成 about:blank，就換成擴充頁。新工作接手或分頁關閉時移除
const leftTabs = new Map();
// 被 Chrome 換掉 ID 的分頁（0.2.11，E1-D14b）：閒置的背景分頁被丟棄（discard）時 Chrome 用新 ID 取代舊分頁
// （tabs.onReplaced），舊 ID 從此查不到；呼叫端（Claude in Chrome 也是）手上只有舊 ID。舊 ID → 新 ID，存 storage.session
const replacedTabs = new Map();
const LINGER = { grace: 3000, max: 60000 };  // 測試會縮短
// 補登（0.3.0）：tabId → { enroll, gen, origin, deadline, home, docs: Map<documentId, frameId>, captured, sent, active,
//   closed, leftTimer }。值不放在這裡：捕獲到的值只轉給原生主程式，不保留
const enrolls = new Map();
// 重啟回報（§4.7）：原生連線中斷時補登分頁的處理結果 { enroll, tab, captured, left, at }，不含任何值
let reports = [];
let detaching = Promise.resolve();
const ENROLL_T = { leftOrigin: 60000, reportTtl: 35 * 60000 };  // 離開來源多久算離開；重啟回報保留多久（測試會縮短）
let port = null;

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    port = null;
    setTimeout(connect, 5000);
    return;
  }
  flushReports();  // 補登的重啟回報（§4.7）：每次連上都再送一次，sbd 依補登 id 去重
  port.onMessage.addListener(async (msg) => {
    const id = msg && msg.id;
    let reply;
    try {
      reply = await withBudget(msg || {});
    } catch (e) {
      reply = { error: "INTERNAL", kind: (e && e.constructor && e.constructor.name) || "Error" };  // 不帶訊息，避免夾帶值
    }
    port?.postMessage({ id, ...reply });
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    detaching = detachEnrolls().catch(() => {});  // 補登分頁：停止捕獲，捕獲過的自行退到擴充頁（§4.7）
    setTimeout(connect, 5000);
  });
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---- 注入到頁面的函式（各自獨立，不能引用外部變數） ----

function pageOriginOk(origin) {
  return /^https?:$/.test(location.protocol) && location.origin === origin;
}

function pageFields(origin, extra) {
  if (!(/^https?:$/.test(location.protocol) && location.origin === origin)) return { error: "URL_MISMATCH" };
  const skip = ["checkbox", "radio", "submit", "button", "reset", "image", "file"];
  const vals = new Set();
  const add = (v) => { if (v && v.length >= 3) { vals.add(v); vals.add(encodeURIComponent(v)); } };
  for (const e of document.querySelectorAll("input,textarea")) if (!skip.includes(e.type)) add(e.value);
  for (const v of extra) add(v);
  const order = [...vals].sort((a, b) => b.length - a.length);
  const mask = (s) => { s = String(s || ""); for (const v of order) s = s.split(v).join("[遮蔽]"); return s; };
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  const q = (s) => CSS.escape(s);
  const fsel = (f) => (f ? (f.id ? "#" + q(f.id) : f.getAttribute("action") ? "form[action=" + JSON.stringify(f.getAttribute("action")) + "]" : "form") : null);
  const own = (e) => (e.id ? "#" + q(e.id) : e.name ? e.tagName.toLowerCase() + "[name=" + JSON.stringify(e.name) + "]" : null);
  const btn = (e) => e.tagName === "BUTTON" || ["submit", "button", "reset"].includes(e.type);
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const fields = [...document.querySelectorAll("input,button,select,textarea,a[href],[role=button]")]
    .filter((e) => e.type !== "hidden" && vis(e) && !e.closest("#" + q("__sb_login_mask__")))
    .slice(0, 60)
    .map((e) => ({
      selector: own(e) || (fsel(e.form) ? fsel(e.form) + " " + e.tagName.toLowerCase() + "[type=" + e.type + "]" : null),
      type: e.type || null,
      name: e.name || null,
      placeholder: cut(mask(e.placeholder), 40) || null,
      label: cut(mask(((e.labels && e.labels[0] && e.labels[0].innerText) || "").trim()), 30) || null,
      // 以下是約定以外的補充欄位（選送出鈕用）：元素種類、按鈕文字、所屬表單
      tag: e.tagName.toLowerCase(),
      text: btn(e) || e.tagName === "A" || e.getAttribute("role") === "button"
        ? cut(mask((e.innerText || e.getAttribute("value") || "").trim()), 30) || null : null,
      form: fsel(e.form),
    }));
  return { fields };
}

function pageState(origin, extra, maskId) {
  if (!(/^https?:$/.test(location.protocol) && location.origin === origin)) return { error: "URL_MISMATCH" };
  const skip = ["checkbox", "radio", "submit", "button", "reset", "image", "file"];
  const vals = new Set();
  const add = (v) => {
    if (!v || v.length < 3) return;
    vals.add(v); vals.add(encodeURIComponent(v)); vals.add(encodeURIComponent(v).replace(/%20/g, "+"));
  };
  for (const e of document.querySelectorAll("input,textarea")) if (!skip.includes(e.type)) add(e.value);
  for (const v of extra) add(v);
  const order = [...vals].sort((a, b) => b.length - a.length);
  const mask = (s) => { s = String(s || ""); for (const v of order) s = s.split(v).join("[遮蔽]"); return s; };
  const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);
  // 讀文字時暫時把遮罩藏起來，避免「登入中」混進頁面文字
  const m = document.getElementById(maskId);
  const prev = m ? m.style.display : null;
  if (m) m.style.display = "none";
  const text = document.body ? document.body.innerText : "";
  if (m) m.style.display = prev;
  return {
    url: cut(mask(location.href), 500),
    title: cut(mask(document.title), 200),
    text: cut(mask(text).trim(), 2000),
    hasPasswordField: !!document.querySelector("input[type=password]"),
  };
}

// ---- 會改頁面的注入：只有這兩個（由 act() 呼叫） ----

// ISOLATED world 的包裝。op：claim、mask、fill、click、release、check、leave；t = { gen, origin }；a = 這個操作的參數。
function pageOp(op, t, a) {
  const G = globalThis;
  const here = (o) => /^https?:$/.test(location.protocol) && location.origin === o;

  // 遮罩：工作期間蓋住工作文件；release 確定乾淨才移除，退到擴充頁（C1）時不移除（往返快取恢復時先看到的是遮罩）
  // 0.2.9（R18-1）：掛在 documentElement（網站整理 body 時不會一起被移除），樣式全部 !important。
  // 建立方式與 dialog-guard-check.js 的 sbMask 相同，改一處要兩處一起改
  const sbMask = (id) => {
    if (!id || document.getElementById(id) || !document.documentElement) return;
    const host = document.createElement("div");
    host.id = id;
    for (const [k, v] of [["all", "initial"], ["position", "fixed"], ["inset", "0"], ["z-index", "2147483647"],
                          ["background", "#1f2328"], ["display", "block"], ["visibility", "visible"], ["opacity", "1"]]) {
      host.style.setProperty(k, v, "important");
    }
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML =
      '<div style="height:100%;display:flex;align-items:center;justify-content:center;' +
      'font:600 20px -apple-system,system-ui,sans-serif;color:#fff">secret-broker 登入中</div>';
    document.documentElement.appendChild(host);
  };
  const addMask = () => { if (a && a.maskId) sbMask(a.maskId); };
  // 離開的文件不留任何網站內容（0.2.10，R19-1）：documentElement 底下除了遮罩與框架全部移除（框架隱藏，見 prune）。
  // 網站之後用自己保存的狀態回填已移除的欄位，也不會顯示。內容與 dialog-guard-check.js 的 wipe 相同，改一處要兩處一起改
  const wipe = () => {
    const FRAMES = new Set(["IFRAME", "FRAME", "OBJECT", "EMBED"]);
    const prune = (parent) => {
      for (const n of [...parent.childNodes]) {
        if (n.id === "__sb_login_mask__") continue;
        if (n.nodeType !== 1) { n.remove(); continue; }
        if (FRAMES.has(n.tagName)) {
          // 框架不移除：移除正跳著原生對話框的跨站子框架會讓分頁卡死（M7）。隱藏它；同來源的框架往裡面繼續清
          n.style.setProperty("display", "none", "important");
          let d = null;
          try { d = n.contentDocument; } catch {}
          if (d && d.documentElement) prune(d.documentElement);
        } else if (n.querySelector("iframe,frame,object,embed")) {
          prune(n);  // 裡面有框架：只留通往框架的空殼
        } else {
          n.remove();
        }
      }
    };
    if (document.documentElement) prune(document.documentElement);
  };
  // 往返快取的生命週期監聽（與 dialog-guard-check.js 共用旗標：同一份文件只掛一次；兩邊的內容要一起改）。
  // 0.2.9（R18-1）：曾屬於工作而且沒有被原地清乾淨（__sbClean）的文件，或已離開的文件（__sbLeft），
  // 在 pagehide 與 pageshow（persisted）時同步重建遮罩，下一個畫面前再確認一次。
  // 0.2.10（R19-1）：已離開的文件恢復時不再靠補遮罩對抗網站整理——同步蓋遮罩、清空內容，
  // 並同步 location.replace("about:blank") 把這份文件換掉（歷史紀錄的這一格被取代，上一頁不會再回到它）；
  // 內容腳本不能直接 replace 到擴充頁（cleared.html 不在 web_accessible_resources），由背景看到 about:blank 後換成擴充頁
  const life = () => {
    if (G.__sbLife) return;
    G.__sbLife = true;
    const veil = () => {
      if (!(G.__sbLeft || (G.__sbDocGen !== undefined && !G.__sbClean))) return;
      sbMask("__sb_login_mask__");
      requestAnimationFrame(() => { if (G.__sbLeft || (G.__sbDocGen !== undefined && !G.__sbClean)) sbMask("__sb_login_mask__"); });
    };
    addEventListener("pagehide", (e) => { if (e.isTrusted && e.persisted) { G.__sbGen = null; veil(); if (G.__sbLeft) wipe(); } });
    addEventListener("pageshow", (e) => {
      if (!e.isTrusted || !e.persisted) return;  // 只認瀏覽器發的事件
      veil();
      if (G.__sbLeft) {
        wipe();
        try { location.replace("about:blank"); } catch {}
      }
      chrome.runtime.sendMessage({ sbLifecycle: 1 }).then((r) => {
        if (r && r.job === true && typeof r.gen === "string" && G.__sbDocGen === r.gen) G.__sbGen = r.gen;
      }, () => {});
    });
  };

  // 核對範圍（0.2.8，R17-2）：頂層文件＋同來源框架（遞迴）＋開放的 shadow root 裡的 input／textarea（非 hidden），
  // 以及 contenteditable 區域的文字。跨來源而且看得見（有大小）的框架讀不到內容：記成無法核對（blind）。
  // 封閉的 shadow root 讀不到，也不知道有沒有，不在範圍內。值只在這個 ISOLATED world 比對，不回傳。
  const values = () => {
    const vals = new Map();  // 交付值 → 欄位種類（username／password）
    for (const d of (a && a.delivered) || []) if (d && typeof d.value === "string" && d.value) vals.set(d.value, d.field);
    for (const [v, f] of G.__sbVals || []) if (!vals.has(v)) vals.set(v, f);  // 恢復的文件：背景已不留值，用頁內記的
    return vals;
  };
  const holder = (vals) => (s) => {
    if (!s) return null;
    for (const [v, f] of vals) if (s === v || (v.length >= 6 && s.includes(v))) return f;
    return null;
  };
  const collect = () => {
    const fields = new Set();
    const edits = [];
    let blind = false;
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = el.ownerDocument.defaultView.getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden";
    };
    const walk = (root, depth) => {
      if (depth > 8) { blind = true; return; }
      for (const el of root.querySelectorAll("*")) {
        const tag = el.tagName;
        if ((tag === "INPUT" && el.type !== "hidden") || tag === "TEXTAREA") fields.add(el);
        else if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) edits.push(el);
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        if (tag === "IFRAME" || tag === "FRAME" || tag === "OBJECT" || tag === "EMBED") {
          let d = null;
          try { d = el.contentDocument; } catch {}
          if (d && d.documentElement) walk(d, depth + 1);
          else if (shown(el)) blind = true;
        }
      }
    };
    walk(document, 0);
    for (const f of G.__sbFilled || []) { const e = f.ref.deref(); if (e && e.isConnected) fields.add(e); }
    return { fields: [...fields], edits, blind };
  };
  // 有交付值的欄位（可清）與 contenteditable（不動網站的內容：有值就算清不掉）
  const scan = (vals, clearPw) => {
    const holds = holder(vals);
    const { fields, edits, blind } = collect();
    const dirty = [];
    for (const el of fields) {
      const f = holds(el.value);
      if (f) dirty.push({ el, f });
      else if (clearPw && el.type === "password" && el.value) dirty.push({ el, f: "password" });
    }
    const stuck = [];
    for (const el of edits) { const f = holds(el.textContent); if (f) stuck.push({ el, f }); }
    return { dirty, stuck, blind };
  };

  if (op === "check") {
    // 唯讀核對（C2(c)：登入成功、填值的文件已換掉）：目前文件範圍內有沒有交付值。不需要世代，不改頁面
    const { dirty, stuck, blind } = scan(values(), a.clear);
    const all = [...dirty, ...stuck];
    return { found: all.length > 0, username: all.some((x) => x.f === "username"), password: all.some((x) => x.f === "password"), blind };
  }

  if (op === "leave") {
    // 退到擴充頁（C1）之前：讓已排程的點擊失效、記下「已離開」（往返快取恢復時同步重建遮罩，R18-1）、
    // 先清空交付過的欄位值（不送事件、不觸發網站的處理程式；網站之後回填也會被同步重建的遮罩蓋住）、蓋上遮罩、掛上監聽
    G.__sbGen = null;
    G.__sbLeft = true;
    try {
      const setIn = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const setTa = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      for (const { el } of scan(values(), a.clear).dirty) (el.tagName === "TEXTAREA" ? setTa : setIn).call(el, "");
    } catch {}
    addMask();
    wipe();  // 0.2.10（R19-1）：凍結前畫面上就沒有任何網站內容，只留遮罩
    life();
    return { ok: true };
  }

  if (op === "release") {
    // 清理：文件曾屬於 t.gen，而且沒有被新工作接手；否則是過期的清理，什麼都不做（R13-2）
    if (typeof t.gen !== "string" || G.__sbDocGen !== t.gen || (G.__sbGen !== t.gen && G.__sbGen !== null)) {
      return { stale: true };
    }
    G.__sbGen = null;  // 先讓已排程的點擊失效（R12-2）
    // 原地清（C2(b)，登入成功而且填值的文件還在）：核對範圍內含交付值的欄位清空 → 下一個 task 才送 input／change →
    // 等 100 毫秒 → 重新掃，最多三輪。晚到也清——這份文件已確認屬於這個已結束的工作。
    // 掃完確定乾淨（沒有交付值、沒有含交付值的 contenteditable、沒有無法核對的框架）才移除遮罩；
    // 否則保留遮罩，由背景退到擴充頁（C1）。這裡只回「當下」的結果，不追網站之後的時序。
    return (async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const setTa = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      const vals = values();
      const tick = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let round = 0; round < 3; round++) {
        const { dirty: d } = scan(vals, a.clear);
        if (!d.length) break;
        for (const { el } of d) (el.tagName === "TEXTAREA" ? setTa : set).call(el, "");
        await tick(0);  // 值已清；網站的處理程式在下一個 task 才跑
        for (const { el } of d) {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await tick(100);
      }
      const { dirty, stuck, blind } = scan(vals, a.clear);
      const left = [...dirty, ...stuck];
      const username_cleared = !left.some((x) => x.f === "username");
      const password_cleared = !left.some((x) => x.f === "password");
      if (!left.length && !blind) {
        G.__sbFilled = [];
        G.__sbVals = new Map();
        G.__sbClean = true;  // 原地清乾淨：往返快取恢復時不再重建遮罩
        document.getElementById(a.maskId)?.remove();
      }
      return { mask: !document.getElementById(a.maskId), username_cleared, password_cleared, blind };
    })();
  }

  if (!here(t.origin)) return { error: "URL_MISMATCH" };

  if (op === "enrollClean") {
    // 補登的原地清理（§4.7 第 3 步）：核對範圍同 release，找含清理集任一值的欄位，清空後再核對；不需要工作世代（補登文件沒有）。
    // 值只在這個 ISOLATED world 比對，不回傳；只回乾不乾淨
    return (async () => {
      const vals = new Map();
      for (const v of (a && a.values) || []) if (typeof v === "string" && v) vals.set(v, "value");
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const setTa = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      const tick = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let round = 0; round < 3; round++) {
        const { dirty: d } = scan(vals, false);
        if (!d.length) break;
        for (const { el } of d) (el.tagName === "TEXTAREA" ? setTa : set).call(el, "");
        await tick(0);
        for (const { el } of d) {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        await tick(100);
      }
      const { dirty, stuck, blind } = scan(vals, false);
      return { clean: dirty.length + stuck.length === 0 && !blind, blind };
    })();
  }

  if (op === "claim") {
    // 工作接手這份文件（bind、open、恢復後由新工作接手；背景記下 documentId）
    G.__sbGen = t.gen;
    G.__sbDocGen = t.gen;
    G.__sbClean = false;
    life();
    return { ok: true };
  }

  if (op === "click" || op === "fill") {
    if (Date.now() > a.deadline) return { error: "PAGE_BLOCKED", late: true };  // 晚到（R10-2）
  }
  // 工作進行中的操作：這份文件目前必須屬於 t.gen
  if (G.__sbGen !== t.gen) {
    return G.__sbGen === undefined && G.__sbDocGen === undefined ? { stale: true, unclaimed: true } : { stale: true };
  }

  if (op === "mask") {
    addMask();
    return { ok: true };
  }

  // 進度記錄（E1-D14）：fill／click 在 ISOLATED world 記下做到哪一步與結果（只有代碼與長度，沒有值），
  // 回覆逾時後背景用 pageProbe 讀回，分得出「已完成只是回覆晚了」「還沒執行」「整頁沒回應」
  const ops = (G.__sbOps = G.__sbOps || {});
  const note = (phase, result) => {
    if (!a || typeof a.opId !== "string") return result;
    ops[a.opId] = { phase, result };
    const keys = Object.keys(ops);
    if (keys.length > 20) delete ops[keys[0]];
    return result;
  };

  if (op === "click") {
    // 只排程、立即回覆（E1-D8）；真正點擊前再核對世代、期限、元素還在而且沒被停用（R12-2）
    let e;
    try { e = document.querySelector(a.selector); } catch { return { error: "NO_ELEMENT" }; }
    if (!e) return { error: "NO_ELEMENT" };
    const ok = e.tagName === "BUTTON" || (e.tagName === "INPUT" && e.type === "submit") || e.tagName === "A" ||
      e.getAttribute("role") === "button";
    if (!ok) return { error: "NOT_CLICKABLE" };
    setTimeout(() => {
      if (G.__sbGen === t.gen && Date.now() <= a.deadline && e.isConnected && !e.disabled) e.click();
    }, 0);
    return note("done", { ok: true, scheduled: true });
  }

  if (op === "fill") {
    let e;
    try { e = document.querySelector(a.selector); } catch { return { error: "NO_FIELD" }; }
    if (!e || e.tagName !== "INPUT" || e.readOnly || e.disabled) return { error: "NO_FIELD" };
    const userTypes = ["text", "email", "tel"];
    if (a.field === "password" ? e.type !== "password" : !userTypes.includes(e.type)) return { error: "NO_FIELD" };
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    note("writing");
    // 記下填過哪個欄位（E1-D15）：release 一定要清掉它。寫入前就記，後面的事件卡住也找得到
    const list = (G.__sbFilled = (G.__sbFilled || []).filter((f) => f.ref.deref() && f.ref.deref() !== e));
    list.push({ ref: new WeakRef(e), field: a.field });
    // 交付值也記在 ISOLATED world（頁面讀不到）：往返快取恢復時背景已不留值，靠這份核對整份表單（R15-1）
    (G.__sbVals = G.__sbVals instanceof Map ? G.__sbVals : new Map()).set(a.value, a.field);
    set.call(e, a.value);
    e.dispatchEvent(new Event("input", { bubbles: true }));   // 網站的處理程式在這裡同步執行，可能很久
    e.dispatchEvent(new Event("change", { bubbles: true }));
    if (e.value.length !== a.value.length) {  // 例如被 maxlength 截斷：清空，不留半個值
      set.call(e, "");
      e.dispatchEvent(new Event("input", { bubbles: true }));
      return note("done", { error: "FILL_FAILED" });
    }
    return note("done", { ok: true, len: a.value.length });
  }
  return { error: "BAD_OP" };
}

// MAIN world 的包裝：對話框保護。op：on（安裝或由 owner 接手）、off（只還原 owner 擁有的保護）。
// 從所在框架遞迴到同來源（可存取）的子框架；跨來源的框架讀不到內容，但 frames 可以穿過去找裡面的同來源框架。
// 安裝內容與 dialog-guard.js 相同，改一處要兩處一起改。
function pageGuard(op, owner, origin) {
  const SYM = Symbol.for("sb.dialogGuard");
  if (typeof owner !== "string" || !owner) return false;
  const walk = (win, f) => {
    try { f(win); } catch {}
    try { for (let i = 0; i < win.frames.length; i++) walk(win.frames[i], f); } catch {}
  };
  if (op === "off") {
    walk(window, (win) => { if (win[SYM]) win[SYM].restore(owner); });  // 擁有者不符的 restore 什麼都不做
    return true;
  }
  walk(window, (win) => {
    if (win.origin !== origin) return;  // window.origin：about:srcdoc 等繼承來源的框架也是真正的來源（R11-1）
    if (win[SYM]) { win[SYM].guard(owner); return; }
    const names = ["alert", "confirm", "prompt"];
    const saved = {};
    for (const k of names) saved[k] = Object.getOwnPropertyDescriptor(win, k);
    const orig = (k) => saved[k] && saved[k].value;
    let state = "guard";
    let own = owner;
    const wrap = {
      alert: function alert(...x) { if (state === "native") return orig("alert").apply(win, x); },
      confirm: function confirm(...x) { return state === "native" ? orig("confirm").apply(win, x) : false; },
      prompt: function prompt(...x) { return state === "native" ? orig("prompt").apply(win, x) : null; },
    };
    for (const k of names) Object.defineProperty(win, k, { value: wrap[k], configurable: true, writable: true });
    const onBeforeUnload = (e) => { if (state !== "native") e.stopImmediatePropagation(); };
    win.addEventListener("beforeunload", onBeforeUnload, true);
    // restore(o)：背景一定帶擁有者；不帶參數是頁面自己還原自己的保護（只影響它自己）
    const restore = (o) => {
      if (o !== undefined && o !== own) return false;
      state = "native";
      for (const k of names) {
        if (saved[k]) Object.defineProperty(win, k, saved[k]);
        else delete win[k];
      }
      win.removeEventListener("beforeunload", onBeforeUnload, true);
      delete win[SYM];
      return true;
    };
    const guard = (o) => { state = "guard"; own = o; return true; };
    Object.defineProperty(win, SYM, { value: { restore, guard }, configurable: true });
  });
  return true;
}

// 讀回 fill／click 的進度記錄（唯讀）：{ phase, result } 或 { seen:false }
function pageProbe(opId) {
  const r = globalThis.__sbOps && globalThis.__sbOps[opId];
  return r ? { phase: r.phase, result: r.result ?? null } : { seen: false };
}

function pageFrameOrigin() {
  return self.origin;  // 不用 location.origin：繼承來源的框架（about:srcdoc）的 location.origin 是 "null"
}

// ---- 背景端 ----

const timeout = (ms, value) => new Promise((res) => setTimeout(() => res(value), ms));

// PAGE_BLOCKED 的診斷：只放分頁狀態與步驟名稱，不放頁面內容、網址或值
async function blocked(ctx, extra = {}) {
  let tabStatus = "unknown";
  let navigating = false;
  let state = {};
  try {
    const t = await Promise.race([chrome.tabs.get(ctx.tab), timeout(500, null)]);
    if (t) {
      tabStatus = t.status === "complete" || t.status === "loading" ? t.status : "unknown";
      navigating = !!t.pendingUrl || t.status === "loading";
      // 0.2.11（E1-D14）：Chrome 把分頁凍結時（背景分頁閒置、螢幕鎖定），注入會排隊到解凍才執行，截圖照常——
      // 和對話框分不出來，所以照實回報分頁本身的狀態（frozen 是 Chrome 132 起的欄位，沒有就不帶）。thaw 叫不醒時才會走到這裡
      if (typeof t.frozen === "boolean") state.tab_frozen = t.frozen;
      if (typeof t.discarded === "boolean") state.tab_discarded = t.discarded;
      if (typeof t.active === "boolean") state.tab_active = t.active;
    }
  } catch {}
  const diag = {
    error: "PAGE_BLOCKED", step: ctx.step || ctx.cmd || "unknown", tab_status: tabStatus, navigating,
    // 注入（含重試）一直逾時，而分頁已載入完成、也沒有在導頁、也沒被凍結：最可能是對話框開著（頁面只是忙的話重試會成功）
    dialog_suspected: !!ctx.timedOut && tabStatus === "complete" && !navigating && state.tab_frozen !== true,
    ...state,
    ...(ctx.seen && ctx.seen.woken ? { tab_woken: true } : {}),
    ...extra,
  };
  console.warn("[secret-broker] PAGE_BLOCKED", JSON.stringify(diag));
  return diag;
}

// 在分頁執行一次注入。opts：world、allFrames、frameIds、documentIds、immediate、wait（毫秒）、step（診斷用的步驟名稱）、
// retry（逾時後重試再等的毫秒數；只給沒有副作用或重做無害的注入）。args 可以是函式（每次嘗試依該次的等待重新計算，例如頁內期限）。
// 逾時回 PAGE_BLOCKED（附診斷）；注入本身不會被取消。
// 被 Chrome 凍結的分頁（E1-D14：背景分頁閒置幾分鐘後、螢幕鎖定時）：注入會排隊到解凍才執行，
// 先送一個輕量注入也叫不醒它（實測）；切成所在視窗的作用中分頁會在幾百毫秒內解凍。
// 只在 tabs.get 回報 frozen 時才切（不搶視窗焦點，只換這個視窗目前顯示的分頁），切過就記在 ctx.seen.woken，回覆帶 tab_woken。
// 回 "ok"（沒被凍結或查不到）、"woken"（已解凍）、"frozen"（等不到解凍）
async function thaw(ctx, tab) {
  const frozen = async () => {
    try { const t = await Promise.race([chrome.tabs.get(tab), timeout(500, null)]); return !!t && t.frozen === true; }
    catch { return false; }
  };
  if (!(await frozen())) return "ok";
  if (ctx.seen) ctx.seen.woken = true;
  try { await chrome.tabs.update(tab, { active: true }); } catch { return "frozen"; }
  for (const until = Date.now() + THAW_WAIT_MS; Date.now() < until;) {
    await timeout(100);
    if (!(await frozen())) return "woken";
  }
  return "frozen";
}

async function inTab(ctx, tab, func, args, opts = {}) {
  ctx.step = `${ctx.cmd}/${opts.step || func.name}`;  // pageOp／pageGuard 用 STEP 的名稱（介面約定的固定步驟）
  ctx.tab = tab;
  const target = { tabId: tab };
  if (opts.documentIds) target.documentIds = opts.documentIds;
  else if (opts.frameIds) target.frameIds = opts.frameIds;
  else if (opts.allFrames) target.allFrames = true;
  try {
    // 注入前先確認分頁沒被凍結（E1-D14）。fill、click 叫不醒就不送：值不寫進一個不會回應的文件
    if ((await thaw(ctx, tab)) === "frozen" && opts.skipIfFrozen) return { ...(await blocked({ ...ctx, timedOut: true })), not_sent: true };
    let pending = null;
    const attempt = (wait) => {
      pending = chrome.scripting.executeScript({
        target, func, args: typeof args === "function" ? args(wait) : args,
        ...(opts.world ? { world: opts.world } : {}), ...(opts.immediate ? { injectImmediately: true } : {}),
      }).then((xs) => ({ xs }));
      return Promise.race([pending, timeout(wait, null)]);
    };
    let r = await attempt(opts.wait || PAGE_WAIT_MS);
    // 等待中分頁被凍結（E1-D14 的 fill/pageOriginOk：寫值後 300 毫秒的來源檢查）：叫醒後等原本那次注入回來，不重送
    if (r === null && (await thaw(ctx, tab)) === "woken") r = await Promise.race([pending, timeout(opts.retry || RETRY_WAIT_MS, null)]);
    if (r === null && opts.retry) r = await attempt(opts.retry);  // 頁面可能只是忙：再試一次
    // 讀取遇到分頁還在載入（D10）：新文件可能還在載入或主執行緒被長請求占住，繼續試到期限；
    // 期限到了還在載入就回 NAVIGATING（請呼叫端再等一次），不當成頁面卡住
    while (r === null && opts.navUntil && Date.now() + 1500 < opts.navUntil && await isNavigating(tab)) {
      await timeout(500);
      r = await attempt(Math.min(2000, opts.navUntil - Date.now()));
    }
    if (r === null) {
      ctx.timedOut = true;
      if (opts.navUntil && await isNavigating(tab)) {
        const d = await blocked(ctx);
        return { ...d, error: "NAVIGATING", dialog_suspected: false };
      }
      return blocked(ctx);
    }
    if (opts.raw) return r.xs;
    if (opts.allFrames || opts.frameIds) {
      return r.xs.length && r.xs.every((x) => x.result === true) ? true : { error: "URL_MISMATCH" };
    }
    return r.xs[0] ? r.xs[0].result : { error: "URL_MISMATCH" };
  } catch (e) {
    // 分頁不存在 → NO_TAB；file:、chrome:、錯誤頁等不能注入的頁面 → 視為來源不符
    return /no tab/i.test(String(e && e.message)) ? { error: "NO_TAB" } : { error: "URL_MISMATCH" };
  }
}
const read = { immediate: true, retry: RETRY_WAIT_MS };   // 讀取、檢查，以及有世代核對、重做無害的注入
const once = { immediate: true };                        // fill、click 不重試

const isOrigin = (o) => {
  try {
    const u = new URL(o);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === o;
  } catch { return false; }
};
const sameOrigin = (url, origin) => {
  try { return new URL(url).origin === origin; } catch { return false; }
};

function waitComplete(tab, timeoutMs = LOAD_WAIT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); resolve(v); } };
    const onUpd = (id, info) => { if (id === tab && info.status === "complete") finish(true); };
    const t = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tab).then((t2) => { if (t2.status === "complete" && !t2.pendingUrl) finish(true); }).catch(() => finish(false));
  });
}

async function isNavigating(tab) {
  try {
    const t = await Promise.race([chrome.tabs.get(tab), timeout(500, null)]);
    return !!t && (t.status === "loading" || !!t.pendingUrl);
  } catch { return false; }
}

// 分頁目前（頂層框架）的文件 ID；讀不到回 null
async function currentDoc(tab) {
  try {
    const f = await Promise.race([chrome.webNavigation.getFrame({ tabId: tab, frameId: 0 }), timeout(500, null)]);
    return f && typeof f.documentId === "string" ? f.documentId : null;
  } catch { return null; }
}

// 頁內期限：依這次注入的等待計算，留一段餘裕讓及時執行的結果一定回得來（重試的等待短，餘裕按比例縮小）
const deadlineFor = (wait) => Date.now() + wait - Math.min(PAGE_DEADLINE_MARGIN_MS, wait / 4);

async function originCheck(ctx, tab, origin) {
  const ok = await inTab(ctx, tab, pageOriginOk, [origin], read);
  if (ok === true) return null;
  if (ok && ok.error === "PAGE_BLOCKED") return ok;
  return ok && ok.error === "NO_TAB" ? { error: "NO_TAB" } : { error: "URL_MISMATCH" };
}


// ---- 對話框保護的註冊 ----

const keyOf = (origin) => origin.replace(/[^A-Za-z0-9]/g, "_");
const mainId = (origin) => GUARD_PREFIX + "main-" + keyOf(origin);
const checkId = (origin) => GUARD_PREFIX + "check-" + keyOf(origin);
const pendingOpens = new Set();  // open 建立分頁中：第一份文件的詢問要等分頁 ID 確定

async function registerGuard(origin) {
  const ids = [mainId(origin), checkId(origin)];
  const have = new Set((await chrome.scripting.getRegisteredContentScripts({ ids })).map((c) => c.id));
  const common = { matches: [origin + "/*"], runAt: "document_start", allFrames: true, matchOriginAsFallback: true,
                   persistAcrossSessions: false };
  const add = [];
  if (!have.has(ids[0])) add.push({ id: ids[0], js: ["dialog-guard.js"], world: "MAIN", ...common });
  if (!have.has(ids[1])) add.push({ id: ids[1], js: ["dialog-guard-check.js"], world: "ISOLATED", ...common });
  if (add.length) await chrome.scripting.registerContentScripts(add);
}
// 這個來源還有工作或保留期在用註冊嗎
const originInUse = (origin) => [...jobs.values()].some((j) => j.origin === origin) ||
  [...lingers.values()].some((l) => l.origin === origin);

async function unregisterGuard(origin) {
  try { await chrome.scripting.unregisterContentScripts({ ids: [mainId(origin), checkId(origin)] }); } catch {}
}


// ---- 唯一的改頁面入口 ----

// 診斷用的步驟名稱沿用介面約定的固定集合（sbd 的 _DIAG_STEPS_BY_CMD）
const STEP = {
  claim: "pageLifecycle", mask: "pageMaskOn", fill: "pageFill", click: "pageClick", release: "pageRelease",
  on: "pageGuardOn", off: "pageGuardOff",
};

// 對分頁執行一個會改頁面的操作。job：{ gen, guardId, origin }（進行中的工作，或可信記錄裡已結束的工作）。
// a：操作參數，或依該次嘗試的等待計算參數的函式（頁內期限）。opts 同 inTab（frameIds、documentIds、wait、retry…）。
// 進行中的操作遇到「從未被任何工作接手」的文件（例如換頁後內容腳本還沒拿到世代），
// 背景確認它在工作分頁、來源相符後先 claim 再做一次；屬於別的工作或已失效就回 stale，不動作。
async function act(ctx, tab, op, job, a, opts = {}) {
  if (op === "on" || op === "off") {
    if (!job.guardId) return true;  // 沒有擁有者可還原
    return inTab(ctx, tab, pageGuard, [op, job.guardId, job.origin || null], { ...opts, world: "MAIN", step: STEP[op] });
  }
  const t = { gen: job.gen, origin: job.origin || null };
  // 可能改頁面的操作（R14-1）：派發前先查目標文件，綁定這份文件派發（查詢與注入之間換頁就不會打到別份）。
  // 0.2.8 起 release 不再靠「動過哪些文件」的記錄判斷：成功時核對目前文件，失敗一律退到擴充頁
  let bound = opts.documentIds;
  if (MUTATES.has(op) && !bound) {
    const doc = await currentDoc(tab);
    if (doc) bound = [doc];
  }
  // 填值的文件（派發前就記）：release 用它分辨「填值的文件還在」（C2(b)）或「已換掉」（C2(c)）
  if (op === "fill" && bound) (job.filled = job.filled || new Set()).add(bound[0]);
  const run = async () => {
    const xs = await inTab(ctx, tab, pageOp, (w) => [op, t, typeof a === "function" ? a(w) : a ?? null],
      { ...opts, ...(bound ? { documentIds: bound } : {}), step: STEP[op], raw: true,
        ...(op === "fill" || op === "click" ? { skipIfFrozen: true } : {}) });
    if (!Array.isArray(xs)) return xs;  // PAGE_BLOCKED、NO_TAB、注入失敗：結果不明
    const x = xs[0];
    if (!x) return { error: "URL_MISMATCH" };
    if (op === "claim" && x.result && x.result.ok) await recordDoc(x.documentId, job.gen);
    return x.result;
  };
  let r = await run();
  if (r && r.unclaimed && op !== "claim" && jobs.get(tab) === job && !opts.documentIds) {
    const c = await act(ctx, tab, "claim", job, null, { ...read, ...(bound ? { documentIds: bound } : {}) });
    if (c && c.ok) r = await run();
  }
  // 回覆逾時（E1-D14）：在指令期限內探頁面，看這次操作到底做了沒
  if (MUTATES.has(op) && opts.probeUntil && a && a.opId && r && r.error === "PAGE_BLOCKED" && !r.not_sent) {
    const p = await probeLate(ctx, tab, bound, a.opId, opts.probeUntil);
    if (p.done) {
      r = p.done;
    } else {
      // 頁面有回應：不是對話框，只是這次操作沒在期限內跑；一直沒回應：對話框、除錯器暫停或很長的同步工作（分不出來）
      r = await blocked({ ...ctx, timedOut: true }, p.responsive ? { page_responsive: true, dialog_suspected: false }
        : { page_responsive: false });
    }
  }
  return r;
}

// fill／click 回覆逾時後讀進度記錄，最多到 until。回 { done: 結果 } 或 { responsive: 頁面有沒有回應過 }
async function probeLate(ctx, tab, bound, opId, until) {
  let responsive = false;
  let unseen = 0;
  while (Date.now() + 500 < until) {
    const x = await inTab({ ...ctx }, tab, pageProbe, [opId],
      { immediate: true, wait: Math.min(1500, until - Date.now()), ...(bound ? { documentIds: bound } : {}) });
    if (x && x.phase === "done" && x.result) return { done: x.result };
    if (!x || x.error === "PAGE_BLOCKED") continue;  // 還是沒回應
    if (x.error) break;                                // 文件已不在、分頁已關
    responsive = true;
    if (x.seen === false && ++unseen >= 2) break;      // 頁面有回應但這次操作一直沒執行：之後執行也已過頁內期限
    await timeout(300);
  }
  return { responsive };
}

const MUTATES = new Set(["mask", "fill", "click"]);

// ---- 可信記錄 ----

// home：「回到登入頁」用的網址（綁定時的來源＋路徑，不含查詢字串與 #：失敗頁的查詢字串可能帶帳號）
const homeOf = (url, origin) => {
  try { const u = new URL(url); return u.origin === origin ? u.origin + u.pathname : origin; } catch { return origin; }
};
function newJob(origin, values, home) {
  const job = { origin, values, home: home || origin, gen: crypto.randomUUID(), guardId: crypto.randomUUID() };
  gens.set(job.gen, { guardId: job.guardId, origin, home: job.home });
  while (gens.size > GENS_LIMIT) gens.delete(gens.keys().next().value);
  return job;
}
async function saveRegistry() {
  try {
    await chrome.storage.session.set({ gens: Object.fromEntries(gens), docs: Object.fromEntries(docs),
                                       guardDocs: Object.fromEntries(guardDocs) });
  } catch {}
}
async function loadRegistry() {  // service worker 重新啟動後接回；記憶體裡已有的優先
  try {
    const s = await chrome.storage.session.get(["gens", "docs", "guardDocs"]);
    for (const [k, v] of Object.entries(s.gens || {})) if (!gens.has(k)) gens.set(k, v);
    for (const [k, v] of Object.entries(s.docs || {})) if (!docs.has(k)) docs.set(k, v);
    for (const [k, v] of Object.entries(s.guardDocs || {})) if (!guardDocs.has(k)) guardDocs.set(k, v);
  } catch {}
}
async function recordDoc(documentId, gen) {
  if (typeof documentId !== "string" || !documentId || !gen) return;
  docs.delete(documentId);
  docs.set(documentId, gen);
  while (docs.size > DOCS_LIMIT) docs.delete(docs.keys().next().value);
  await saveRegistry();
}
async function recordGuardDoc(documentId, l) {
  if (typeof documentId !== "string" || !documentId || !l || !l.guardId) return;
  guardDocs.delete(documentId);
  guardDocs.set(documentId, { guardId: l.guardId, origin: l.origin });
  while (guardDocs.size > DOCS_LIMIT) guardDocs.delete(guardDocs.keys().next().value);
  await saveRegistry();
}
// clear：release 時要不要清密碼；inPlace：原地清理（登入成功）。不是原地清理的文件從往返快取恢復時再退到擴充頁
async function markReleased(gen, clear, inPlace) {
  const info = gens.get(gen);
  if (info) { info.clear = clear; info.inPlace = inPlace === true; }
  await saveRegistry();
}
async function markLeft(gen) {
  const info = gens.get(gen);
  if (info) info.inPlace = false;
  await saveRegistry();
}

// 工作分頁記到 storage.session：service worker 重新啟動後還知道要清理哪些分頁
async function persist() {
  const out = {};
  for (const [tab, j] of jobs) out[tab] = { origin: j.origin, gen: j.gen, guardId: j.guardId, home: j.home, autoDisc: j.autoDisc };
  const lg = {};
  for (const [tab, l] of lingers) lg[tab] = { origin: l.origin, gen: l.gen, guardId: l.guardId };
  const left = Object.fromEntries(leftTabs);
  const rep = Object.fromEntries(replacedTabs);
  try { await chrome.storage.session.set({ jobs: out, lingers: lg, leftTabs: left, replacedTabs: rep }); } catch {}
}

// 兩種詢問：sbDialogGuard（新文件要不要保護；要的話一併給世代與保護擁有者，並記下這份文件屬於工作）、
// sbLifecycle（從往返快取恢復，R12-1、R13-1）。答案只看 sender（頁面改不了），訊息內容不參與判斷。
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || !msg) return false;
  if (msg.sbDialogGuard === 1) {
    (async () => {
      if (!jobs.has(sender.tab.id) && pendingOpens.size) await Promise.all([...pendingOpens]);
      const job = jobs.get(sender.tab.id);
      const guard = !!job && job.origin === sender.origin;
      if (guard) {
        await recordDoc(sender.documentId, job.gen);
        reply({ guard, gen: job.gen, guardId: job.guardId });
        return;
      }
      const l = lingers.get(sender.tab.id);
      if (l && l.origin === sender.origin) {
        // 保留期：保護但不給世代——這份文件不屬於任何進行中的工作，不能蓋遮罩、填值或點擊。
        // 記下保護歸屬（R14-2）：它進往返快取、保留期結束後才回來時，靠這份記錄還原
        await recordGuardDoc(sender.documentId, l);
        reply({ guard: true, guardId: l.guardId });
        return;
      }
      reply({ guard: false });
    })();
    return true;
  }
  if (msg.sbLifecycle === 1) {
    resumed(sender).then(reply, () => reply({ job: false }));
    return true;
  }
  if (msg.sbEnrollAuth === 1) {
    enrollAuth(sender).then(reply, () => reply({ ok: false }));
    return true;
  }
  if (msg.sbEnroll === 1) {
    enqueueCapture(msg, sender);  // 同步入列：依到達（操作）順序處理，不讓非同步雜湊打亂（R28-1）
    return false;  // 不回覆：內容腳本不需要知道有沒有收下
  }
  if (msg.sbEnrollBye === 1) {
    onBye(msg, sender).catch(() => {});
    return false;
  }
  if (msg.sbEnrollCancel === 1) {
    onCancelClicked(sender).catch(() => {});
    return false;
  }
  return false;
});

// 文件從往返快取恢復。只有可信記錄裡曾屬於工作的文件才處理（R13-1）：
//   - 它的工作還在：回世代，內容腳本接回。
//   - 工作已結束：只對這份文件（documentId）清理，照 release 當時的 clear_password（記錄不知道就清）；
//     清理帶著它那個工作的世代與擁有者，所以碰不到新工作的東西。
//   - 分頁上已有同來源的新工作：清完由新工作接手（claim、保護、遮罩）。
async function resumed(sender) {
  await cleanup;
  const tab = sender.tab.id;
  const gen = sender.documentId ? docs.get(sender.documentId) : undefined;
  const job = jobs.get(tab);
  if (!gen) return resumedGuardDoc(sender, job);
  if (job && job.gen === gen) return { job: true, gen };
  const info = gens.get(gen) || {};
  const old = { gen, guardId: info.guardId, origin: info.origin, home: info.home };
  const clear = info.clear !== false;
  const ctx = { cmd: "resume", start: Date.now() };
  const doc = { documentIds: [sender.documentId], immediate: true, retry: RETRY_WAIT_MS };
  const mine = !!job && job.origin === sender.origin && sender.frameId === 0;  // 分頁上有同來源的新工作：清完交給它
  if (!mine && info.inPlace !== true) {
    // 沒有原地清理過的文件（登入沒成功、退過擴充頁、結果不明，R17-3）：凍結前就有遮罩，恢復時先看到遮罩；
    // 不在畫面上清，直接再退到擴充頁（頂層文件才導頁）
    if (sender.frameId === 0) await leaveTab(ctx, tab, old);
    return { job: false };
  }
  const [r] = await Promise.all([
    act({ ...ctx }, tab, "release", old, { maskId: MASK_ID, clear }, doc),
    act({ ...ctx }, tab, "off", old, null, doc),
  ]);
  if (mine) {
    await act({ ...ctx }, tab, "claim", job, null, doc);
    await act({ ...ctx }, tab, "on", job, null, doc);
    await act({ ...ctx }, tab, "mask", job, { maskId: MASK_ID }, doc);
  } else if (sender.frameId === 0 && r && !r.stale &&
             !(r.mask === true && r.username_cleared === true && r.password_cleared === true && r.blind !== true)) {
    await leaveTab(ctx, tab, old);  // 原地清不乾淨或無法核對：退到擴充頁（C1）
  }
  return { job: false };
}

// 保留期文件從往返快取恢復（R14-2）：保留期還在（同一個擁有者）就維持；否則只還原它那份保護（帶它的擁有者，碰不到新工作的保護），
// 不授予任何操作。分頁上已有同來源的新工作：還原後由新工作接手（和工作文件恢復時相同）。
async function resumedGuardDoc(sender, job) {
  const tab = sender.tab.id;
  const g = sender.documentId ? guardDocs.get(sender.documentId) : undefined;
  if (!g) return { job: false };  // 從未屬於工作、也不是保留期文件：什麼都不做（R13-1）
  const l = lingers.get(tab);
  if (l && l.guardId === g.guardId) return { job: false };
  const ctx = { cmd: "resume" };
  const doc = { documentIds: [sender.documentId], immediate: true, retry: RETRY_WAIT_MS };
  const r = await act({ ...ctx }, tab, "off", g, null, doc);
  if (r === true) {
    guardDocs.delete(sender.documentId);
    await saveRegistry();
  }
  if (job && job.origin === sender.origin && sender.frameId === 0) {
    await act({ ...ctx }, tab, "claim", job, null, doc);
    await act({ ...ctx }, tab, "on", job, null, doc);
    await act({ ...ctx }, tab, "mask", job, { maskId: MASK_ID }, doc);
  }
  return { job: false };
}

// release 的清理契約（0.2.8，R17-1、R17-2、R17-3）：不再用「等待＋掃描」追網站的時序。
//   C2(a) 登入沒有成功（outcome 不是 "ok"，未知也算）：不原地清，一律退到擴充頁（C1）。
//   C2(b) 登入成功、填值的文件還在：原地清，再在核對範圍內核對（見 pageOp 的 collect）；仍有值或無法核對 → C1。
//   C2(c) 登入成功、填值的文件已換掉（或沒回應、結果不明）：唯讀核對目前文件；有值、無法核對或沒回應 → C1。
//   C1：把分頁導到擴充自己的頁面（cleared.html）。分頁網址確實變成擴充頁才回 cleared_by=extension_page：
//       網站的內容已不在畫面上，沒有時序與範圍的問題。
// 成功時的清除結果放在 ctx.cleared（release 的回覆與 sbd 稽核用）
function cleared(ctx, by) {
  ctx.cleared = { username_cleared: true, password_cleared: true, cleared_by: by };
  return null;
}
const EXT_PAGE = chrome.runtime.getURL("cleared.html");
const onExtPage = (url) => typeof url === "string" && url.startsWith(EXT_PAGE);
// 指令預算結束前多久要回覆
const deadlineOf = (ctx) => (ctx.start || Date.now()) + (BUDGET_MS[ctx.cmd] || COMMAND_BUDGET_MS) - LEAVE_MARGIN_MS;

// C2(b)、C2(c)：登入成功時的清理。遮罩與密碼欄、還原保護兩件事並行，各自逾時重試一次；
// 每次嘗試都帶這個工作的世代與擁有者，第一次嘗試晚到也只會落空（R13-2）。
async function cleanTab(ctx, tab, job, clearPassword, wait = RELEASE_WAIT_MS, retry = RELEASE_RETRY_MS, keepGuard = false) {
  const opts = { immediate: true, wait, retry };
  const delivered = job.delivered || [];
  const check = async () => {
    const c = await inTab({ ...ctx }, tab, pageOp, ["check", { gen: null, origin: null }, { delivered, clear: clearPassword }],
      { immediate: true, wait: CHECK_WAIT_MS, step: "pageCheck" });
    if (c && c.error === "NO_TAB") return "gone";
    return c && c.found === false && c.blind !== true ? "clean" : "dirty";
  };
  // 目前文件是不是填值的文件（fill 派發時綁定的文件）。查不到文件 ID、或不是填值的文件 → C2(c)
  const cur = await currentDoc(tab);
  const filledHere = !!cur && !!job.filled && job.filled.has(cur);
  if (!filledHere && (job.filled && job.filled.size)) {
    // C2(c)：填值的文件已換掉。先唯讀核對目前文件的欄位（畫面文字顯示帳號名不算，F60）；有值、無法核對、沒回應 → C1
    const c = await check();
    if (c === "gone") return cleared(ctx, "gone");
    if (c === "dirty") return leaveTab(ctx, tab, job);
  }
  const [page, guard] = await Promise.all([
    act({ ...ctx }, tab, "release", job, { maskId: MASK_ID, clear: clearPassword, delivered }, opts),
    keepGuard ? true : act({ ...ctx }, tab, "off", job, null, opts),
  ]);
  if (page && page.error === "NO_TAB") return cleared(ctx, "gone");  // 分頁已關：文件都不在了
  // 清理注入連重試都沒回應（對話框、長任務）：唯讀核對也一定卡住，直接退到擴充頁，把剩下的預算留給導頁（0.2.9，R18 六項）。
  // 對話框開著時 Chrome 換頁會關掉它，不必先關或接受對話框
  if (page && page.error === "PAGE_BLOCKED") return leaveTab(ctx, tab, job, { unresponsive: true });
  if (page && !page.error && !page.stale) {
    // 工作的文件（填值的文件，或換頁後由工作接手的新文件）：原地清後核對。
    // 乾淨、沒有無法核對的框架、遮罩已移除、保護已還原才算清掉；否則 C1
    const clean = page.mask === true && page.username_cleared === true && page.password_cleared === true && page.blind !== true;
    if (clean && guard === true) return cleared(ctx, filledHere ? "page" : "gone");
    return leaveTab(ctx, tab, job);
  }
  // 目前文件不屬於這個工作（已換到別的來源等），或沒回應、不能注入：唯讀核對目前文件
  let t = null;
  try { t = await chrome.tabs.get(tab); } catch { return cleared(ctx, "gone"); }
  if (onExtPage(t.url)) return cleared(ctx, "extension_page");
  if (!/^https?:/.test(t.url || "")) {
    // 錯誤頁等不是網站內容的文件：裡面沒有網站的欄位。導頁還沒完成（pendingUrl）就結果不明
    if (!t.pendingUrl) return cleared(ctx, "gone");
    return leaveTab(ctx, tab, job);
  }
  const c = await check();
  if (c === "gone" || c === "clean") return cleared(ctx, "gone");
  return leaveTab(ctx, tab, job);
}

// C1：把分頁導到擴充頁，直到分頁網址確實變成擴充頁（或指令期限前）。成功回 null（cleared_by=extension_page）。
// 離開的文件：先蓋遮罩並掛往返快取監聽（工作文件本來就有遮罩，這裡不移除）；記進可信記錄，
// 從往返快取恢復時 resumed() 依記錄再退一次（R17-3：恢復時先看到的是凍結前就在的遮罩，不靠背景往返）。
async function leaveTab(ctx, tab, job, { unresponsive = false } = {}) {
  let t = null;
  try { t = await chrome.tabs.get(tab); } catch { return cleared(ctx, "gone"); }
  if (onExtPage(t.url) && !t.pendingUrl) return cleared(ctx, "extension_page");
  const before = await currentDoc(tab);
  if (before && !docs.has(before)) await recordDoc(before, job.gen);
  await markLeft(job.gen);
  if (!jobs.has(tab)) {
    leftTabs.set(tab, { origin: job.origin, gen: job.gen, guardId: job.guardId, home: job.home });
    await persist();
  }
  if (/^https?:/.test(t.url || "")) {
    // 離開前：清空交付值、記下已離開、蓋遮罩。頁面已確定沒回應時不等它（注入照樣送出，頁面空出來時若還在就會執行）
    const leaving = inTab({ ...ctx }, tab, pageOp,
      ["leave", { gen: job.gen, origin: null }, { maskId: MASK_ID, delivered: job.delivered || [], clear: true }],
      { immediate: true, wait: LEAVE_MASK_MS, step: "pageLeave" });
    if (!unresponsive) await leaving;
  }
  const q = new URLSearchParams({ o: job.origin || "", h: job.home || job.origin || "" });
  try { await chrome.tabs.update(tab, { url: `${EXT_PAGE}?${q}` }); } catch {
    try { await chrome.tabs.get(tab); } catch { return cleared(ctx, "gone"); }
  }
  const end = deadlineOf(ctx);
  while (Date.now() < end) {
    await timeout(50);
    let x = null;
    try { x = await chrome.tabs.get(tab); } catch { return cleared(ctx, "gone"); }
    // 已提交的網址是擴充頁：頂層框架已不是網站的文件（webNavigation 查不到擴充頁的文件 ID，只看網址）
    if (onExtPage(x.url) && !x.pendingUrl) return cleared(ctx, "extension_page");
  }
  console.warn("[secret-broker] release：沒能在期限內把分頁換成擴充頁", JSON.stringify({ tab }));
  return { ...await blocked({ ...ctx, step: `${ctx.cmd}/tabs.update` }), mask_removed: false, username_cleared: false,
           password_cleared: false };
}

// 工作期間不讓 Chrome 自動丟棄工作分頁（D14b：丟棄後文件與交付的值都不在了，分頁還換了 ID）；結束時還原成原本的設定
async function keepFromDiscard(tab, job, was) {
  job.autoDisc = typeof was === "boolean" ? was : true;
  try { await chrome.tabs.update(tab, { autoDiscardable: false }); } catch {}
}
async function restoreDiscard(tab, job) {
  if (!job || job.autoDisc === false) return;  // 原本就不可丟棄：維持
  try { await chrome.tabs.update(tab, { autoDiscardable: true }); } catch {}
}
// 舊 ID 依替換紀錄找到目前的分頁（可能連續被換過幾次）
function resolveTab(tab) {
  let t = tab;
  for (let i = 0; i < 10 && replacedTabs.has(t); i++) t = replacedTabs.get(t);
  return t;
}
// 被丟棄的分頁（D14b）：文件已不在，重新載入並等它載完才能綁定。只在 bind 用（還沒交付任何值，重新載入不會丟掉代填的東西）
async function revive(ctx, tab) {
  let t;
  try { t = await chrome.tabs.get(tab); } catch { return null; }
  if (!t.discarded) return t;
  ctx.seen.reloaded = true;
  try { await chrome.tabs.reload(tab); } catch { return t; }
  await waitComplete(tab, LOAD_WAIT_MS);
  try { return await chrome.tabs.get(tab); } catch { return null; }
}

// 結束一個工作分頁。不是工作分頁就沒有屬於工作的文件可清（R13-1），直接成功。
// outcome："ok"（登入成功）走 C2(b)／(c)；"internal"（open／bind 自己失敗，還沒交付任何值）原地清；其他一律 C1。
async function releaseTab(ctx, tab, clearPassword, outcome = "failed") {
  const job = jobs.get(tab);
  if (!job) return null;
  jobs.delete(tab);  // 先刪：之後的換頁不再蓋遮罩、內容腳本的詢問回 native；填過的值一併丟掉
  job.values.clear();  // 交付值改由 job.delivered 帶到清理，清完就丟
  await restoreDiscard(tab, job);  // 工作期間不讓 Chrome 丟棄這個分頁；結束就還原（D14b）
  const inPlace = outcome === "ok" || outcome === "internal";
  await markReleased(job.gen, clearPassword, inPlace);
  if (!inPlace) {
    // 分頁要換成擴充頁：網站的新文件不會再出現，不需要保留期
    await persist();
    if (!originInUse(job.origin)) await unregisterGuard(job.origin);
    return leaveTab(ctx, tab, job);
  }
  // 分頁還在導頁或載入（D10）：首頁載完前常會跳 alert，現在就還原保護，原生對話框會把分頁卡住。
  // 保護保留到分頁載完再過一段時間（startLinger）。保留期要先開始，註冊才不會被移除
  const loading = await isNavigating(tab);
  if (loading) startLinger(tab, job);
  await persist();
  if (!originInUse(job.origin)) await unregisterGuard(job.origin);
  return cleanTab(ctx, tab, job, clearPassword, RELEASE_WAIT_MS, RELEASE_RETRY_MS, loading);
}

// ---- 保留期 ----

function startLinger(tab, job) {
  stopLinger(tab);
  const l = { origin: job.origin, guardId: job.guardId, gen: job.gen, until: Date.now() + LINGER.max, timer: null };
  lingers.set(tab, l);
  l.timer = setTimeout(() => endLinger(tab, l), LINGER.max);
  // 已經載完（例如 release 之後很快完成）也要排一次寬限
  chrome.tabs.get(tab).then((t) => { if (t.status === "complete" && !t.pendingUrl) graceLinger(tab); }).catch(() => endLinger(tab, l));
}
function graceLinger(tab) {
  const l = lingers.get(tab);
  if (!l) return;
  clearTimeout(l.timer);
  l.timer = setTimeout(() => endLinger(tab, l), Math.max(0, Math.min(LINGER.grace, l.until - Date.now())));
}
function stopLinger(tab) {  // 不還原（新工作接手、分頁關閉）
  const l = lingers.get(tab);
  if (!l) return null;
  clearTimeout(l.timer);
  lingers.delete(tab);
  return l;
}
// 保留期結束：只還原這個擁有者的保護（擁有者不符的不動），沒人用的註冊移除
async function endLinger(tab, l) {
  if (lingers.get(tab) !== l) return;
  stopLinger(tab);
  await persist();
  if (!originInUse(l.origin)) await unregisterGuard(l.origin);
  await act({ cmd: "linger" }, tab, "off", l, null, { immediate: true, wait: PAGE_WAIT_MS, retry: RETRY_WAIT_MS });
}

// service worker 重新啟動（工作狀態只在記憶體，已經沒了）：移除所有註冊，接回可信記錄，
// 清理上一輪記下的工作分頁（release 當時的要求不知道：清密碼）。回傳是否全部清理成功（測試也直接呼叫它）。
async function startupCleanup() {
  let ok = true;
  try {
    const ids = (await chrome.scripting.getRegisteredContentScripts()).map((c) => c.id).filter((id) => id.startsWith(GUARD_PREFIX));
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  } catch { ok = false; }
  await loadRegistry();
  let stale = {};
  try { stale = (await chrome.storage.session.get("jobs")).jobs || {}; } catch {}
  let staleLinger = {};
  try { staleLinger = (await chrome.storage.session.get("lingers")).lingers || {}; } catch {}
  try {
    const rep = (await chrome.storage.session.get("replacedTabs")).replacedTabs || {};
    for (const [from, to] of Object.entries(rep)) if (Number.isInteger(to) && !replacedTabs.has(Number(from))) replacedTabs.set(Number(from), to);
  } catch {}
  try {
    const left = (await chrome.storage.session.get("leftTabs")).leftTabs || {};
    for (const [tab, v] of Object.entries(left)) if (v && typeof v.gen === "string" && !leftTabs.has(Number(tab))) leftTabs.set(Number(tab), v);
  } catch {}
  await Promise.all(Object.entries(staleLinger).map(async ([tab, l]) => {
    if (l && typeof l.guardId === "string" && !lingers.has(Number(tab))) {
      await act({ cmd: "startup" }, Number(tab), "off", l, null, { immediate: true, wait: PAGE_WAIT_MS, retry: RETRY_WAIT_MS });
    }
  }));
  await startupEnrolls();
  await Promise.all(Object.entries(stale).map(async ([tab, j]) => {
    if (!j || typeof j.gen !== "string") return;
    // 上一輪的工作結果不明：一律退到擴充頁（C2(a)）
    if (await leaveTab({ cmd: "startup", start: Date.now() }, Number(tab), j)) ok = false;
    await restoreDiscard(Number(tab), j);
  }));
  await persist();
  return ok;
}
const cleanup = startupCleanup().catch(() => false);

// 每個指令的總期限：都比 sbd 對該指令的等待短，逾時回 PAGE_BLOCKED（附診斷），不讓 sbd 斷線
function withBudget(m) {
  // seen：整個指令共用（ctx 會被淺拷貝），記下這次有沒有喚醒過被凍結的分頁
  const ctx = { cmd: m.cmd, step: null, tab: m.tab, start: Date.now(), seen: {} };
  const budget = BUDGET_MS[m.cmd] || COMMAND_BUDGET_MS;
  return Promise.race([handle(m, ctx), timeout(budget, null).then((v) => v || blocked({ ...ctx, timedOut: true }))])
    .then((r) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) return r;
      const notes = { ...(ctx.seen.woken ? { tab_woken: true } : {}), ...(ctx.seen.reloaded ? { tab_reloaded: true } : {}),
                      ...(ctx.seen.replaced ? { tab_replaced: true } : {}) };
      return Object.keys(notes).length ? { ...r, ...notes } : r;
    });
}

// 工作分頁換頁完成後重新蓋遮罩（新文件屬於這個工作才蓋）
chrome.tabs.onUpdated.addListener((tab, info, tabInfo) => {
  if (info.url && enrolls.has(tab)) enrollUrlChanged(tab, info.url);
  if (lingers.has(tab)) {
    if (info.status === "complete") graceLinger(tab);
    else if (info.status === "loading") {  // 又開始載入：等它載完再重新算寬限（總長仍受 LINGER.max 限制）
      const l = lingers.get(tab);
      clearTimeout(l.timer);
      l.timer = setTimeout(() => endLinger(tab, l), Math.max(0, l.until - Date.now()));
    }
  }
  const job = jobs.get(tab);
  if (info.status === "complete" && job) act({ cmd: "remask" }, tab, "mask", job, { maskId: MASK_ID }, read);
  // 退過擴充頁的分頁變成 about:blank：離開的舊文件從往返快取恢復、被內容腳本換掉了（R19-1）→ 換成擴充頁。
  // 一般由 pageshow 送的 sbLifecycle 先觸發退回；這層是備援（文件已被換掉、訊息送不到或 service worker 剛重啟時）
  const left = leftTabs.get(tab);
  if (left && !job && (info.url === "about:blank" || (info.status === "complete" && tabInfo && tabInfo.url === "about:blank"))) {
    leaveTab({ cmd: "resume", start: Date.now() }, tab, left).catch(() => {});
  }
});
// 分頁被換掉 ID（丟棄、預先轉譯）：記下對照，工作與退過擴充頁的記錄跟著搬到新 ID（D14b）。
// 保留期不搬：它保護的是舊文件（已不在），而且計時器綁著舊 ID——直接結束（還原只影響它自己的擁有者，沒人用的註冊移除）
chrome.tabs.onReplaced.addListener((added, removed) => {
  enrollReplaced(added, removed);
  replacedTabs.set(removed, added);
  if (replacedTabs.size > 200) replacedTabs.delete(replacedTabs.keys().next().value);
  for (const map of [jobs, leftTabs]) {
    if (map.has(removed) && !map.has(added)) { map.set(added, map.get(removed)); map.delete(removed); }
  }
  const l = lingers.get(removed);
  if (l) endLinger(removed, l).catch(() => {});
  persist();
});
// 分頁關閉：文件都不在了，只結束工作
chrome.tabs.onRemoved.addListener((tab) => {
  enrollRemoved(tab);
  if (leftTabs.delete(tab)) persist();
  const l = stopLinger(tab);
  if (l) { persist(); if (!originInUse(l.origin)) unregisterGuard(l.origin); }
  const job = jobs.get(tab);
  if (!job) return;
  jobs.delete(tab);
  markReleased(job.gen, true);
  persist();
  if (!originInUse(job.origin)) unregisterGuard(job.origin);
});


// ==== 補登（0.3.0，設計 2026-11-13-webcred-enroll-design.md §2.4、§3、§4.7） ====
// 背景只轉送：授權（依 sender 判定）、捕獲（嚴格格式、補上可信欄位）、控制事件、清理與退頁。
// 補登不改頁面：不蓋遮罩、不攔對話框（§3.1）；提示列由內容腳本在頂層文件畫，徽章在頁面之外。

const ENROLL_ID = /^[0-9a-f]{8}-[A-Za-z0-9_-]{22}$/;
const enrollRegId = (origin) => GUARD_PREFIX + "enroll-" + keyOf(origin);
const ENROLL_FLAGS = new Set(["password_only", "dest_unknown"]);
const ENROLL_STEPS = new Set(["full", "username", "password"]);
const DEFAULT_TITLE = "secret-broker 登入";

const enrollJob = (E) => ({ origin: E.origin, gen: E.gen, guardId: null, home: E.home || E.origin, delivered: [] });
const enrollTitle = (origin) => `secret-broker 補登中：${origin}${origin.startsWith("http:") ? "（未加密）" : ""}`;

function postEvent(ev) {
  if (!port) return false;
  try { port.postMessage(ev); return true; } catch { return false; }
}

async function saveEnrolls() {
  const out = {};
  for (const [tab, E] of enrolls) out[tab] = { enroll: E.enroll, captured: E.captured, origin: E.origin };  // 不記任何值
  try { await chrome.storage.session.set({ enrolls: out, enrollReports: reports }); } catch {}
}

async function setBadge(tab, origin) {
  try {
    await chrome.action.setBadgeText({ tabId: tab, text: origin ? "補" : "" });
    await chrome.action.setTitle({ tabId: tab, title: origin ? enrollTitle(origin) : DEFAULT_TITLE });
  } catch {}
}

async function registerEnroll(origin) {
  const id = enrollRegId(origin);
  const have = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (have.length) return;
  await chrome.scripting.registerContentScripts([{ id, js: ["enroll-capture.js"], matches: [origin + "/*"],
    runAt: "document_start", allFrames: true, world: "ISOLATED", persistAcrossSessions: false }]);
}
async function unregisterEnroll(origin) {
  if ([...enrolls.values()].some((E) => E.active && !E.stopping && E.origin === origin)) return;
  try { await chrome.scripting.unregisterContentScripts({ ids: [enrollRegId(origin)] }); } catch {}
}

function pageEnrollReady() {
  const p = globalThis.__sbEnrollReady;
  return p ? p.then((r) => r === true, () => false) : false;
}
function pageEnrollStop() {
  return typeof globalThis.__sbEnrollStop === "function" ? globalThis.__sbEnrollStop() : true;
}

// 頂層框架目前是不是補登來源（頂層已換來源時，舊框架的訊息一律不收）
async function topIsOrigin(tab, origin) {
  try {
    const f = await Promise.race([chrome.webNavigation.getFrame({ tabId: tab, frameId: 0 }), timeout(500, null)]);
    return !!f && sameOrigin(f.url, origin);
  } catch { return false; }
}

// 授權（§3.2）：只看 sender。補登工作進行中、沒過「等 owner」期限、分頁是補登分頁、文件來源精確相符、
// 頂層或同來源框架（about:blank、srcdoc 這類繼承來源的不授權）、頂層仍是補登來源
async function enrollAuth(sender) {
  const tab = sender.tab.id;
  const E = enrolls.get(tab);
  if (!E || !E.active || E.stopping || Date.now() > E.deadline) return { ok: false };
  if (sender.origin !== E.origin || !/^https?:/.test(sender.url || "") || !sameOrigin(sender.url, E.origin)) return { ok: false };
  if (typeof sender.documentId !== "string" || !Number.isInteger(sender.frameId)) return { ok: false };
  if (sender.frameId !== 0 && !(await topIsOrigin(tab, E.origin))) return { ok: false };
  if (enrolls.get(tab) !== E || !E.active || E.stopping) return { ok: false };
  E.docs.set(sender.documentId, sender.frameId);
  const top = sender.frameId === 0;
  return { ok: true, enroll: E.enroll, gen: E.gen, origin: E.origin, deadline: E.deadline, top,
           ...(top ? { banner: { origin: E.origin, insecure: E.origin.startsWith("http:") } } : {}) };
}

// 捕獲（§3.6）：嚴格格式；可信欄位（文件、框架、來源、分頁）一律取自 sender，不採用內容腳本自報。不符就丟棄、不回覆
const CAPTURE_KEYS = new Set(["sbEnroll", "gen", "seq", "reads", "step", "form_sig", "flags", "submit_seen", "username", "password"]);
function captureOk(m) {
  if (Object.keys(m).some((k) => !CAPTURE_KEYS.has(k))) return false;
  if (typeof m.gen !== "string" || !Number.isInteger(m.seq) || m.seq < 1 || !ENROLL_STEPS.has(m.step)) return false;
  if (!Number.isInteger(m.reads) || m.reads < m.seq || m.reads > 100000) return false;
  if (typeof m.form_sig !== "string" || !/^[0-9a-f]{8}$/.test(m.form_sig) || typeof m.submit_seen !== "boolean") return false;
  if (!Array.isArray(m.flags) || m.flags.some((f) => !ENROLL_FLAGS.has(f)) || new Set(m.flags).size !== m.flags.length) return false;
  const u = m.username, p = m.password;
  if (u !== undefined && (typeof u !== "string" || !u || u.length > 256)) return false;
  if (p !== undefined && (typeof p !== "string" || !p || p.length > 1024)) return false;
  if (m.step === "username") return u !== undefined && p === undefined;
  if (m.step === "full") return u !== undefined && p !== undefined;
  return p !== undefined && u === undefined && m.flags.includes("password_only");
}
// 捕獲入口（R28-1）：每個工作一條佇列。訊息到達時同步取得工作並入列，之後依序完成驗證、雜湊與轉送，
// 前一筆完成才處理下一筆——轉送順序就是到達順序（同一份文件的訊息依送出順序到達）。
// 佇列有上限：超過就丟棄這筆（只丟值，不轉送）；它已計入內容腳本回報的讀到數目，停止時判不完整、一律退頁。
// 控制事件（取消、分頁關閉、離開來源）不經這條佇列。
const CAPTURE_QUEUE_MAX = 16;
function enqueueCapture(m, sender) {
  const E = enrolls.get(sender.tab.id);
  if (!E || !E.active) return;
  if (E.queued >= CAPTURE_QUEUE_MAX) return;
  E.queued += 1;
  E.chain = E.chain.then(() => onCapture(m, sender, E)).catch(() => {}).then(() => { E.queued -= 1; });
}
async function onCapture(m, sender, queuedFor) {
  const tab = sender.tab.id;
  const E = enrolls.get(tab);
  if (E !== queuedFor) return;
  if (!E || !E.active || Date.now() > E.deadline || !captureOk(m) || m.gen !== E.gen) return;
  if (sender.origin !== E.origin || !E.docs.has(sender.documentId) || E.docs.get(sender.documentId) !== sender.frameId) return;
  if (sender.frameId !== 0 && !(await topIsOrigin(tab, E.origin))) return;
  if (m.step === "username" && sender.frameId !== 0) return;  // 多步登入只限頂層框架（§3.5）
  if (enrolls.get(tab) !== E || !E.active) return;
  E.captured = true;  // 頁面上已有 owner 輸入的值：斷線時要退頁
  // 轉送過的值記加鹽雜湊（只在記憶體，不存 storage）：release 時確認 sbd 給的清理集涵蓋它們，否則不原地清（R27-1）
  for (const v of [m.username, m.password]) if (v !== undefined) E.digests.add(await valueDigest(E, v));
  if (enrolls.get(tab) !== E || !E.active) return;
  bump(E.reads, sender.documentId, m.reads);
  E.recv.set(sender.documentId, (E.recv.get(sender.documentId) || 0) + 1);
  const ev = { event: "enroll_capture", enroll: E.enroll, gen: E.gen,
    attempt: { doc: sender.documentId, frame: sender.frameId, seq: m.seq, step: m.step, form_sig: m.form_sig,
               submit_seen: m.submit_seen },
    tab, origin: E.origin, flags: [...m.flags] };
  if (m.username !== undefined) ev.username = m.username;
  if (m.password !== undefined) ev.password = m.password;
  if (postEvent(ev)) E.sent += 1;
  await saveEnrolls();
}

// 文件離開時的告別（只有讀到的數目）：停止時這份文件已不在，靠它確認讀到的都已送達
async function onBye(m, sender) {
  const E = enrolls.get(sender.tab.id);
  if (!E || !E.docs.has(sender.documentId) || Object.keys(m).some((k) => k !== "sbEnrollBye" && k !== "reads")) return;
  if (!Number.isInteger(m.reads) || m.reads < 0 || m.reads > 100000) return;
  bump(E.reads, sender.documentId, m.reads);
  E.bye.add(sender.documentId);
}
const bump = (map, k, v) => { if (!(map.get(k) >= v)) map.set(k, v); };
async function valueDigest(E, v) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(E.salt + "\u0000" + v));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function onCancelClicked(sender) {
  const tab = sender.tab.id;
  const E = enrolls.get(tab);
  if (!E || !E.active || sender.frameId !== 0 || !E.docs.has(sender.documentId)) return;
  postEvent({ event: "enroll_cancel_clicked", enroll: E.enroll, tab });
}

// 停止捕獲（§3.2 第 4 點；R27-1 收斂）：
//   1. 不再授權新文件（stopping），但仍接收已授權文件的捕獲；
//   2. 對授權過的每份文件執行停止：內容腳本先送出延遲中的捕獲，再停收，回報這份文件讀到的嘗試數；
//   3. 等每份文件收到的捕獲數追上讀到的數目（最多 STOP_SETTLE_MS）；
//   4. 才停止接收、取消註冊、刪除可信記錄。
// 回 { captures_sent, complete }：captures_sent 是「讀到的」嘗試數（已轉送＋讀到但沒送達＋無法確認時至少多 1），
// sbd 比對自己收到的數目就會判出不完整；complete=false 時擴充自己也不原地清理（enroll_release 一律退頁）
const STOP_SETTLE_MS = 1500;
function stopCapture(tab, E) {
  if (E.stopPromise) return E.stopPromise;
  E.stopping = true;
  E.stopPromise = (async () => {
    clearTimeout(E.leftTimer);
    E.leftTimer = null;
    const ids = [...E.docs.keys()];
    let unknown = false;
    if (!E.closed) {
      let present = null;
      try {
        const fs = await Promise.race([chrome.webNavigation.getAllFrames({ tabId: tab }), timeout(1000, null)]);
        if (Array.isArray(fs)) present = new Set(fs.map((f) => f.documentId));
      } catch {}
      const rs = await Promise.all(ids.map((d) => Promise.race([
        chrome.scripting.executeScript({ target: { tabId: tab, documentIds: [d] }, func: pageEnrollStop, injectImmediately: true })
          .then((xs) => (xs && xs[0] ? xs[0].result : null), () => null), timeout(PAGE_WAIT_MS, null)])));
      ids.forEach((d, i) => {
        const r = rs[i];
        if (r && Number.isInteger(r.reads)) bump(E.reads, d, r.reads);
        // 沒回應：文件還在（或查不到分頁的文件清單）就無法確認；已不在而且送過告別才算確認
        else if (present === null || present.has(d) || !E.bye.has(d)) unknown = true;
      });
      const end = Date.now() + STOP_SETTLE_MS;
      const behind = () => [...E.reads].some(([d, n]) => (E.recv.get(d) || 0) < n) || E.queued > 0;
      while (behind() && Date.now() < end) await timeout(50);
    }
    // 已入列的捕獲：等它們依序處理完（期限內）；之後才停止接收，入列中還沒處理的會因工作已停而丟棄並判不完整
    if (E.queued > 0) await Promise.race([E.chain, timeout(Math.max(0, STOP_SETTLE_MS / 2))]);
    E.active = false;
    await unregisterEnroll(E.origin);
    E.docs.clear();
    if (!E.closed) await setBadge(tab, null);
    let missing = 0;
    let recvTotal = 0;
    for (const [d, n] of E.reads) missing += Math.max(0, n - (E.recv.get(d) || 0));
    for (const n of E.recv.values()) recvTotal += n;
    const notPosted = Math.max(0, recvTotal - E.sent);
    const captures_sent = E.sent + notPosted + missing + (unknown ? 1 : 0);
    E.stopResult = { captures_sent, complete: captures_sent === E.sent };
    return E.stopResult;
  })();
  return E.stopPromise;
}
async function finishEnroll(tab, E) {
  if (enrolls.get(tab) === E) enrolls.delete(tab);
  await stopCapture(tab, E);
  E.digests.clear();
  await saveEnrolls();
}

// 分頁事件（控制事件，不經佇列；§3.7）
function enrollRemoved(tab) {
  const E = enrolls.get(tab);
  if (!E || E.closed) return;
  E.closed = true;
  postEvent({ event: "enroll_tab_event", enroll: E.enroll, tab, kind: "closed" });
  stopCapture(tab, E).then(saveEnrolls, () => {});
}
function enrollReplaced(added, removed) {
  const E = enrolls.get(removed);
  if (!E || enrolls.has(added)) return;
  enrolls.delete(removed);
  enrolls.set(added, E);
  postEvent({ event: "enroll_tab_event", enroll: E.enroll, tab: removed, kind: "replaced", new_tab: added });
  saveEnrolls();
}
// 頂層離開補登來源超過 ENROLL_T.leftOrigin：送 left_origin（回到來源就取消計時）
function enrollUrlChanged(tab, url) {
  const E = enrolls.get(tab);
  if (!E || !E.active) return;
  if (sameOrigin(url, E.origin)) { clearTimeout(E.leftTimer); E.leftTimer = null; return; }
  if (E.leftTimer) return;
  E.leftTimer = setTimeout(() => {
    E.leftTimer = null;
    if (enrolls.get(tab) === E && E.active) postEvent({ event: "enroll_tab_event", enroll: E.enroll, tab, kind: "left_origin" });
  }, ENROLL_T.leftOrigin);
}

// 原生連線中斷（sbd 重啟等）：停止捕獲；捕獲過的補登分頁自行退到擴充頁並確認；記下重啟回報（§4.7）
async function detachEnrolls() {
  for (const [tab, E] of [...enrolls]) {
    await stopCapture(tab, E);
    let left = false;
    if (E.captured && !E.closed) {
      const ctx = { cmd: "enroll_detach", start: Date.now(), seen: {} };
      left = (await leaveTab(ctx, tab, enrollJob(E))) === null;
    } else if (E.closed) {
      left = true;  // 分頁已關：網站內容已不在
    }
    reports.push({ enroll: E.enroll, tab, captured: E.captured === true, left, at: Date.now() });
    if (enrolls.get(tab) === E) enrolls.delete(tab);
  }
  reports = reports.slice(-32);
  await saveEnrolls();
}
async function flushReports() {
  await 0;  // 等模組初始化完成（connect 在檔案開頭就呼叫）
  await cleanup;
  await detaching;
  const now = Date.now();
  reports = reports.filter((r) => now - r.at < ENROLL_T.reportTtl);
  for (const r of reports) postEvent({ event: "enroll_restart_report", enroll: r.enroll, tab: r.tab, captured: r.captured, left: r.left });
  await saveEnrolls();
}
// service worker 重新啟動：上一輪的補登工作與原生連線都已不在，等同斷線
async function startupEnrolls() {
  let stored = {};
  try {
    const s = await chrome.storage.session.get(["enrolls", "enrollReports"]);
    stored = s.enrolls || {};
    for (const r of s.enrollReports || []) if (r && typeof r.enroll === "string") reports.push(r);
  } catch {}
  for (const [t, v] of Object.entries(stored)) {
    const tab = Number(t);
    if (!v || typeof v.enroll !== "string" || enrolls.has(tab)) continue;
    try {
      await Promise.race([chrome.scripting.executeScript({ target: { tabId: tab, allFrames: true }, func: pageEnrollStop,
        injectImmediately: true }), timeout(PAGE_WAIT_MS, null)]);
    } catch {}
    await setBadge(tab, null);
    let left = false;
    if (v.captured) {
      const ctx = { cmd: "enroll_detach", start: Date.now(), seen: {} };
      left = (await leaveTab(ctx, tab, { origin: v.origin || "", gen: "enroll-" + v.enroll, guardId: null, home: v.origin || "", delivered: [] })) === null;
    }
    reports.push({ enroll: v.enroll, tab, captured: v.captured === true, left, at: Date.now() });
  }
  reports = reports.slice(-32);
  await saveEnrolls();
}

function enrollArgs(m) {
  if (typeof m.enroll !== "string" || !ENROLL_ID.test(m.enroll)) return false;
  if (["enroll_bind", "enroll_open"].includes(m.cmd)) {
    if (typeof m.gen !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(m.gen)) return false;
    if (typeof m.deadline !== "number" || !Number.isFinite(m.deadline) || m.deadline <= Date.now()) return false;
  }
  return true;
}
function newEnroll(m, home) {
  return { enroll: m.enroll, gen: m.gen, origin: m.origin, deadline: m.deadline, home, docs: new Map(), captured: false,
           recv: new Map(), reads: new Map(), bye: new Set(), digests: new Set(), salt: crypto.randomUUID(),
           stopping: false, stopPromise: null, stopResult: null, chain: Promise.resolve(), queued: 0,
           sent: 0, active: true, closed: false, leftTimer: null };
}
// 已載入的文件：只對頂層與同來源的 http(s) 框架注入，每個框架回報授權就緒才算綁定成功（§3.2 第 1 點）
async function injectEnroll(ctx, tab, origin) {
  ctx.step = "enroll_bind/frames";
  let frames = null;
  try { frames = await Promise.race([chrome.webNavigation.getAllFrames({ tabId: tab }), timeout(1000, null)]); } catch {}
  if (!Array.isArray(frames)) return blocked(ctx);
  const ids = frames.filter((f) => /^https?:/.test(f.url) && sameOrigin(f.url, origin)).map((f) => f.frameId);
  if (!ids.includes(0)) return { error: "URL_MISMATCH" };
  ctx.step = "enroll_bind/inject";
  const inj = await Promise.race([chrome.scripting.executeScript({ target: { tabId: tab, frameIds: ids }, files: ["enroll-capture.js"],
    injectImmediately: true }).then(() => true, () => false), timeout(PAGE_WAIT_MS, null)]);
  if (inj === null) return blocked({ ...ctx, timedOut: true });
  if (!inj) return { error: "URL_MISMATCH" };
  const xs = await inTab(ctx, tab, pageEnrollReady, [], { frameIds: ids, immediate: true, raw: true, step: "pageEnrollReady" });
  if (!Array.isArray(xs)) return xs && xs.error === "PAGE_BLOCKED" ? xs : { error: "PAGE_BLOCKED", step: "enroll_bind/ready" };
  if (xs.length < ids.length || !xs.every((x) => x.result === true)) return { error: "PAGE_BLOCKED", step: "enroll_bind/ready" };
  return null;
}

async function handleEnroll(m, ctx) {
  const cmd = m.cmd;
  if (cmd === "enroll_end_all") {
    for (const [tab, E] of [...enrolls]) await finishEnroll(tab, E);
    return { ok: true };
  }
  if (!enrollArgs(m)) return { error: "BAD_ARGS" };
  await cleanup;

  if (cmd === "enroll_bind") {
    if (jobs.has(m.tab) || lingers.has(m.tab)) return { error: "BUSY" };  // 代登入工作或保留期的分頁（§2.4）
    const ex = enrolls.get(m.tab);
    if (ex) return { error: "BUSY" };
    let t;
    try { t = await chrome.tabs.get(m.tab); } catch { return { error: "NO_TAB" }; }
    const bad = await originCheck(ctx, m.tab, m.origin);
    if (bad) return bad;
    const E = newEnroll(m, homeOf(t.url, m.origin));
    enrolls.set(m.tab, E);
    leftTabs.delete(m.tab);  // 比照新工作接手：不再把這個分頁的 about:blank 換成擴充頁
    await persist();
    await registerEnroll(m.origin);
    const fail = await injectEnroll(ctx, m.tab, m.origin);
    if (fail) { await finishEnroll(m.tab, E); return fail; }
    try { await chrome.tabs.update(m.tab, { active: true }); } catch {}  // 切成該視窗的作用中分頁（§10 第 3 題）
    await setBadge(m.tab, m.origin);
    await saveEnrolls();
    return { ok: true, tab: m.tab };
  }

  if (cmd === "enroll_open") {
    if (!sameOrigin(m.url, m.origin)) return { error: "URL_MISMATCH" };
    await registerEnroll(m.origin);
    let t;
    try { t = await chrome.tabs.create({ url: "about:blank", active: true }); } catch { return { error: "NO_TAB" }; }
    const E = newEnroll(m, homeOf(m.url, m.origin));
    enrolls.set(t.id, E);  // 先登記再導航：第一份文件的授權詢問要找得到
    await saveEnrolls();
    try { await chrome.tabs.update(t.id, { url: m.url }); } catch { await finishEnroll(t.id, E); return { error: "NO_TAB" }; }
    await timeout(50);
    await waitComplete(t.id);
    const bad = await originCheck(ctx, t.id, m.origin);
    const ready = bad ? null : await inTab(ctx, t.id, pageEnrollReady, [], { frameIds: [0], immediate: true, raw: true, step: "pageEnrollReady" });
    if (bad || !Array.isArray(ready) || !ready[0] || ready[0].result !== true) {
      await finishEnroll(t.id, E);
      return bad || (ready && ready.error === "PAGE_BLOCKED" ? ready : { error: "PAGE_BLOCKED", step: "enroll_open/ready" });
    }
    await setBadge(t.id, m.origin);
    return { ok: true, tab: t.id };
  }

  const E = enrolls.get(m.tab);
  if (!E || E.enroll !== m.enroll) return { error: "NOT_BOUND" };

  if (cmd === "enroll_stop") {
    const r = await stopCapture(m.tab, E);
    await saveEnrolls();
    return { ok: true, captures_sent: r.captures_sent, complete: r.complete };
  }
  if (cmd === "enroll_end") {
    await finishEnroll(m.tab, E);
    return { ok: true };
  }
  if (cmd === "enroll_release") {
    // §4.7：mode "leave"（清理完整性不完整，不帶值）直接退到擴充頁；mode "clean" 先原地清清理集的值，清不乾淨才退頁
    if (!["leave", "clean"].includes(m.mode)) return { error: "BAD_ARGS" };
    let values = [];
    if (m.mode === "clean") {
      if (!Array.isArray(m.values) || m.values.length > 32 || m.values.some((v) => typeof v !== "string" || !v || v.length > 1024)) {
        return { error: "BAD_ARGS" };
      }
      if (!["ok", "failed"].includes(m.outcome)) return { error: "BAD_ARGS" };
      values = m.values;
    } else if (m.values !== undefined) {
      return { error: "BAD_ARGS" };
    }
    const stopped = await stopCapture(m.tab, E);
    if (E.closed) { await finishEnroll(m.tab, E); return { ok: true, cleared_by: "gone" }; }
    try { await chrome.tabs.get(m.tab); } catch { await finishEnroll(m.tab, E); return { ok: true, cleared_by: "gone" }; }
    // 原地清理的前提（R27-1）：停止時確認讀到的捕獲都已送達，而且 sbd 給的清理集涵蓋擴充轉送過的每個值
    let covered = false;
    if (m.mode === "clean" && stopped.complete) {
      const given = new Set(await Promise.all(values.map((v) => valueDigest(E, v))));
      covered = [...E.digests].every((d) => given.has(d));
    }
    if (m.mode === "clean" && covered) {
      const r = await inTab(ctx, m.tab, pageOp, ["enrollClean", { gen: null, origin: E.origin }, { values }],
        { immediate: true, wait: RELEASE_WAIT_MS, retry: RELEASE_RETRY_MS, step: "pageEnrollClean" });
      values = null;
      if (r && r.clean === true) { await finishEnroll(m.tab, E); return { ok: true, cleared_by: "page" }; }
      if (r && r.error === "NO_TAB") { await finishEnroll(m.tab, E); return { ok: true, cleared_by: "gone" }; }
    }
    const x = await leaveTab(ctx, m.tab, enrollJob(E));
    await finishEnroll(m.tab, E);
    return x || { ok: true, ...(ctx.cleared || {}) };
  }
  return { error: "UNKNOWN_CMD" };
}

const NEED = {
  open: ["url", "origin"], bind: ["tab", "origin"], nav: ["tab", "origin", "url"], fields: ["tab", "origin"],
  click: ["tab", "origin", "selector"], state: ["tab", "origin"], fill: ["tab", "origin", "selector", "field", "value"],
  release: ["tab"], ping: [], reload: [],
  enroll_bind: ["tab", "origin", "enroll", "gen", "deadline"], enroll_open: ["url", "origin", "enroll", "gen", "deadline"],
  enroll_stop: ["tab", "enroll"], enroll_release: ["tab", "enroll", "mode"], enroll_end: ["tab", "enroll"], enroll_end_all: [],
};

async function handle(m, ctx) {
  const cmd = m.cmd;
  if (!(cmd in NEED)) return { error: "UNKNOWN_CMD" };
  for (const k of NEED[cmd]) if (m[k] === undefined || m[k] === null || m[k] === "") return { error: "BAD_ARGS" };
  if (NEED[cmd].includes("tab") && !Number.isInteger(m.tab)) return { error: "BAD_ARGS" };
  if (Number.isInteger(m.tab)) {
    await cleanup;  // 替換紀錄在啟動清理時才從 storage.session 載回
    const now = resolveTab(m.tab);
    if (now !== m.tab) { ctx.seen.replaced = true; m = { ...m, tab: now }; ctx.tab = now; }
  }
  if (NEED[cmd].includes("origin") && !isOrigin(m.origin)) return { error: "BAD_ARGS" };
  if (cmd === "fill" && !["username", "password"].includes(m.field)) return { error: "BAD_ARGS" };
  if (cmd.startsWith("enroll_")) return handleEnroll(m, ctx);
  // 補登分頁不能被代登入工作接手或操作（§2.4）
  if (["bind", "nav", "release"].includes(cmd) && enrolls.has(m.tab)) return { error: "BUSY" };

  switch (cmd) {
    case "ping":
      return { ok: true, version: chrome.runtime.getManifest().version };

    case "reload": {
      // 先結束所有工作（移除遮罩、清密碼欄、還原對話框保護）；任何頁面清理失敗就不重新載入、回 PAGE_BLOCKED。
      await detachEnrolls();  // 補登分頁：停止捕獲，捕獲過的退到擴充頁
      const results = await Promise.all([...jobs.keys()].map((t) => releaseTab(ctx, t, true)));
      // 重新載入後保留期的計時就沒了：現在就結束（還原保護）
      await Promise.all([...lingers.entries()].map(([t, l]) => endLinger(t, l)));
      const ids = (await chrome.scripting.getRegisteredContentScripts()).map((c) => c.id).filter((id) => id.startsWith(GUARD_PREFIX));
      if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
      const failed = results.find((r) => r);
      if (failed) return failed;
      setTimeout(() => chrome.runtime.reload(), 200);
      return { ok: true };
    }

    case "open": {
      if (!sameOrigin(m.url, m.origin)) return { error: "URL_MISMATCH" };
      await cleanup;
      await registerGuard(m.origin);  // 先註冊再開分頁：第一份文件載入時就有保護
      let t;
      let done;
      const opening = new Promise((r) => { done = r; });
      pendingOpens.add(opening);
      const job = newJob(m.origin, new Set(), homeOf(m.url, m.origin));
      try {
        t = await chrome.tabs.create({ url: m.url, active: false });
        jobs.set(t.id, job);  // 第一份文件的詢問要得到 guard
        leftTabs.delete(t.id);
        await keepFromDiscard(t.id, job, t.autoDiscardable);
      } finally {
        pendingOpens.delete(opening);
        done();
      }
      await persist();
      await saveRegistry();
      await waitComplete(t.id);
      const bad = await originCheck(ctx, t.id, m.origin);
      if (bad) {
        await releaseTab(ctx, t.id, false, "internal");  // 還沒交付任何值：原地清理就好
        return bad;
      }
      await act(ctx, t.id, "claim", job, null, read);
      await act(ctx, t.id, "mask", job, { maskId: MASK_ID }, read);
      return { ok: true, tab: t.id };
    }

    case "bind": {
      const cur = await revive(ctx, m.tab);
      if (!cur) return { error: "NO_TAB" };
      const bad = await originCheck(ctx, m.tab, m.origin);
      if (bad) return bad;
      await cleanup;
      await registerGuard(m.origin);
      stopLinger(m.tab);  // 新工作接手這個分頁：保護改由新擁有者持有（pageGuard on）
      const prev = jobs.get(m.tab);
      // 每次 bind 都是新的工作世代與保護擁有者：舊工作已排程的點擊、晚到的清理都失效（R12-2、R13-2）
      const job = newJob(m.origin, prev && prev.origin === m.origin ? prev.values : new Set(), homeOf(cur.url, m.origin));
      if (prev) await markReleased(prev.gen, true, true);  // 由新工作接手（舊文件恢復時交給新工作）
      jobs.set(m.tab, job);
      await keepFromDiscard(m.tab, job, prev ? prev.autoDisc : cur.autoDiscardable);
      leftTabs.delete(m.tab);  // 新工作接手：不再把這個分頁的 about:blank 換成擴充頁
      if (prev && prev.origin !== m.origin && !originInUse(prev.origin)) await unregisterGuard(prev.origin);
      await persist();
      await saveRegistry();
      // 當下的文件立即安裝：先查每個框架的實際來源，只對相符的框架注入（R11-1）
      const frames = await inTab(ctx, m.tab, pageFrameOrigin, [], { allFrames: true, immediate: true, raw: true, retry: RETRY_WAIT_MS });
      const ids = Array.isArray(frames) ? frames.filter((f) => f.result === m.origin).map((f) => f.frameId) : null;
      const g = ids && ids.length ? await act(ctx, m.tab, "on", job, null, { frameIds: ids, immediate: true }) : frames;
      if (g !== true) {
        await releaseTab(ctx, m.tab, false, "internal");
        return g && g.error === "PAGE_BLOCKED" ? g : { error: "URL_MISMATCH" };
      }
      const life = await act(ctx, m.tab, "claim", job, null, read);
      if (!life || life.ok !== true) {
        await releaseTab(ctx, m.tab, false, "internal");
        return life && life.error === "PAGE_BLOCKED" ? life : { error: "URL_MISMATCH" };
      }
      await act(ctx, m.tab, "mask", job, { maskId: MASK_ID }, read);
      return { ok: true };
    }

    case "release": {
      // 頁面清理任何一步失敗都不回 ok（R10-2、R11-2）；工作本身一律結束
      // outcome：sbd 的登入結果，只有 "ok" 算成功（缺少或其他值一律當沒成功，退到擴充頁）
      const failed = await releaseTab(ctx, m.tab, m.clear_password === true, m.outcome === "ok" ? "ok" : "failed");
      return failed || { ok: true, ...(ctx.cleared || {}) };
    }
  }

  // 以下指令只能操作工作分頁，而且 origin 要和工作分頁記錄的一致
  const job = jobs.get(m.tab);
  if (!job) {
    try { await chrome.tabs.get(m.tab); } catch { return { error: "NO_TAB" }; }
    // 分頁存在但不是工作分頁：仍先比對來源（來源不符一律 URL_MISMATCH），再回 NOT_BOUND
    return (await originCheck(ctx, m.tab, m.origin)) || { error: "NOT_BOUND" };
  }
  if (job.origin !== m.origin) return { error: "URL_MISMATCH" };
  const sideEffectDeadline = () => deadlineFor(PAGE_WAIT_MS);
  // 進行中的操作落空（文件屬於別的工作或已失效）：照逾時處理，不動作
  const settle = (r) => (r && (r.late || r.stale) ? blocked(ctx) : r);

  switch (cmd) {
    case "nav": {
      const bad = await originCheck(ctx, m.tab, m.origin);
      if (bad) return bad;
      if (!sameOrigin(m.url, m.origin)) return { error: "URL_MISMATCH" };
      ctx.step = "nav/tabs.update";
      await chrome.tabs.update(m.tab, { url: m.url });
      ctx.step = "nav/waitComplete";
      await waitComplete(m.tab, NAV_WAIT_MS);
      const bad2 = await originCheck(ctx, m.tab, m.origin);
      if (bad2) return bad2;
      await act(ctx, m.tab, "mask", job, { maskId: MASK_ID }, read);
      return { ok: true };
    }
    case "fields":
      return inTab(ctx, m.tab, pageFields, [m.origin, [...job.values]], { ...read, navUntil: ctx.start + NAV_READ_MS });
    case "state":
      return inTab(ctx, m.tab, pageState, [m.origin, [...job.values], MASK_ID], { ...read, navUntil: ctx.start + NAV_READ_MS });
    case "click":
      return settle(await act(ctx, m.tab, "click", job, { selector: String(m.selector), deadline: sideEffectDeadline(),
        opId: crypto.randomUUID() }, { ...once, probeUntil: ctx.start + PROBE_UNTIL_MS }));
    case "fill": {
      const value = String(m.value);
      job.values.add(value);  // 先記：之後的 state／fields 要遮這個值（就算結果沒回來，值也可能已寫入）
      (job.delivered = job.delivered || []).push({ field: m.field, value });  // release 要核對整份表單（R15-1）
      const r = await settle(await act(ctx, m.tab, "fill", job,
        { selector: String(m.selector), field: m.field, value, deadline: sideEffectDeadline(), opId: crypto.randomUUID() },
        { ...once, probeUntil: ctx.start + PROBE_UNTIL_MS }));
      if (!r || !r.ok) return r && r.error ? (r.error === "PAGE_BLOCKED" ? r : { error: r.error }) : { error: "FILL_FAILED" };
      // 寫入後等一下再比一次來源（例如 input 事件觸發導頁）
      await new Promise((res) => setTimeout(res, 300));
      const bad = await originCheck(ctx, m.tab, m.origin);
      // 值已寫入，之後的來源檢查才卡住（E1-D14 的 step=fill/pageOriginOk）：照實標 value_written，release 一定會清
      if (bad) return bad.error === "PAGE_BLOCKED" ? { ...bad, value_written: true } : bad;
      return { ok: true, len: r.len };
    }
  }
  return { error: "UNKNOWN_CMD" };
}
