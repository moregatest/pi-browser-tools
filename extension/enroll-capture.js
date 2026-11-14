// 補登捕獲（0.3.0，設計 2026-11-13-webcred-enroll-design.md §3）。ISOLATED world；兩條路徑共用這支：
//   - 背景對補登來源註冊的 document_start、allFrames 內容腳本（之後導航的文件）；
//   - enroll_bind 時背景用 executeScript 注入已載入的文件。
// 一執行就同步掛監聽，但在拿到背景授權之前一律不讀值；授權前發生的動作作廢，不補讀（§3.2）。
// 授權只依背景以 sender（分頁、來源、框架、documentId）判定，訊息內容不帶任何授權。
// 只認 ISOLATED world 自己觀察到的可信動作（§3.3）：點擊送出鈕、在表單欄位按 Enter；submit 事件只當佐證。
// 值只在可信動作的捕獲階段同步讀取，用 ISOLATED world 自己的原型 getter（頁面改寫 MAIN world 的原型影響不到）。
// 值不進 console、不進 storage；送出後區域變數設成 null。捕獲不改頁面：不清欄位、不攔送出。
(() => {
  const G = globalThis;
  // 註冊的腳本與 executeScript 可能都跑到同一份文件；已安裝過（例如新的補登工作綁定同一份文件）就重新詢問授權
  if (G.__sbEnrollInstalled) { if (typeof G.__sbEnrollReask === "function") G.__sbEnrollReask(); return; }
  G.__sbEnrollInstalled = true;

  const MAX_USER = 256;
  const MAX_PASS = 1024;
  const ENTER_HOLD_MS = 1000;  // Enter 的衍生點擊最晚在放開 Enter 前後出現；保險上限
  const FLUSH_MS = 400;      // 沒看到 submit 時，最多等多久送出這次捕獲
  const BANNER_ID = "__sb_enroll_bar__";
  const NAMED = /顯示|隱藏|取消|忘記|註冊|返回|\bshow\b|\bhide\b|cancel|forgot|register|\bback\b/i;
  const CAPTCHA = /captcha|驗證碼|otp|code/i;

  // 平台 getter（取自 ISOLATED world 的原型；表單的具名屬性，例如 <input name="action">，蓋不掉）
  const desc = (C, k) => Object.getOwnPropertyDescriptor(C.prototype, k).get;
  const inputValue = desc(HTMLInputElement, "value");
  const inputType = desc(HTMLInputElement, "type");
  const formAction = desc(HTMLFormElement, "action");
  const formMethod = desc(HTMLFormElement, "method");
  const formElements = desc(HTMLFormElement, "elements");
  const btnFormAction = desc(HTMLButtonElement, "formAction");
  const btnFormMethod = desc(HTMLButtonElement, "formMethod");
  const btnType = desc(HTMLButtonElement, "type");
  const inFormAction = desc(HTMLInputElement, "formAction");
  const inFormMethod = desc(HTMLInputElement, "formMethod");
  const hasAttr = Element.prototype.hasAttribute;
  const getAttr = Element.prototype.getAttribute;

  let auth = null;     // { enroll, gen, origin, deadline, top, banner? }，只在這個閉包裡
  let seq = 0;         // 這份文件的嘗試序號（單調遞增）
  let enterFor = null; // 這次 Enter 動作所屬的表單：它的隱式提交會衍生一個 detail=0 的 click，不另算嘗試（R27-4）
  let enterTimer = null;
  let reads = 0;       // 這份文件讀到值的嘗試數（含還沒送出的）：停止時回報，背景據此確認全部送達（R27-1）
  let everAuth = false;
  let pending = null;  // 已讀值、等 submit 佐證或計時送出的捕獲
  let readyResolve;
  G.__sbEnrollReady = new Promise((r) => { readyResolve = r; });

  const expired = () => !auth || Date.now() > auth.deadline;
  const visible = (el) => {
    if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const typeOf = (el) => (el instanceof HTMLInputElement ? inputType.call(el) : "");
  const untyped = (el) => el instanceof HTMLInputElement && getAttr.call(el, "type") === null;
  const labelText = (el) => {
    try { return [...(el.labels || [])].map((l) => l.textContent || "").join(" "); } catch { return ""; }
  };
  const isCaptcha = (el) => CAPTCHA.test([getAttr.call(el, "name"), el.id, getAttr.call(el, "placeholder"), labelText(el)]
    .filter(Boolean).join(" "));
  const readable = (el) => visible(el) && !el.readOnly && !el.disabled && !isCaptcha(el);
  const isPassword = (el) => el instanceof HTMLInputElement && typeOf(el) === "password";
  const isUserLike = (el) => el instanceof HTMLInputElement && (["text", "email", "tel"].includes(typeOf(el)) || untyped(el));
  const val = (el) => inputValue.call(el);
  const controls = (form) => [...formElements.call(form)];

  // 表單裡看得見的密碼欄與帳號欄（§3.4）
  const passwords = (list) => list.filter((e) => isPassword(e) && visible(e));
  const pickUser = (list, pw) => {
    const cands = list.filter((e) => isUserLike(e) && readable(e));
    const auto = cands.find((e) => /\busername\b/i.test(getAttr.call(e, "autocomplete") || ""));
    if (auto && val(auto)) return auto;
    let best = null;
    for (const e of cands) {
      if (pw && !(e.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;  // 要在密碼欄之前
      if (val(e)) best = e;
    }
    return best;
  };

  // 有效提交者與有效 action（§3.4 送出目的地，依 HTML 表單提交規則）
  const isSubmitBtn = (e) => (e instanceof HTMLButtonElement && btnType.call(e) === "submit") ||
    (e instanceof HTMLInputElement && ["submit", "image"].includes(typeOf(e)));
  const BLOCKS_IMPLICIT = new Set(["text", "search", "url", "tel", "email", "password", "date", "month", "week", "time",
    "datetime-local", "number"]);
  // Enter：預設按鈕（表單關聯元素中第一個送出鈕）；停用就不提交；沒有預設按鈕時，阻擋隱式提交的欄位超過一個就不提交
  const implicitSubmitter = (form) => {
    const list = controls(form);
    const def = list.find(isSubmitBtn);
    if (def) return def.disabled ? undefined : def;
    const blocking = list.filter((e) => e instanceof HTMLInputElement && BLOCKS_IMPLICIT.has(typeOf(e))).length;
    return blocking > 1 ? undefined : null;
  };
  const destination = (form, sub) => {
    const own = sub && hasAttr.call(sub, "formaction");
    const action = own ? (sub instanceof HTMLButtonElement ? btnFormAction : inFormAction).call(sub) : formAction.call(form);
    const ownM = sub && hasAttr.call(sub, "formmethod");
    const method = ownM ? (sub instanceof HTMLButtonElement ? btnFormMethod : inFormMethod).call(sub) : formMethod.call(form);
    if (String(method).toLowerCase() === "dialog") return null;
    try {
      const u = new URL(action || location.href, document.baseURI);
      return u.origin === auth.origin ? u.origin : null;  // 跨來源、降級（https → http）、無法解析：都不產生嘗試
    } catch { return null; }
  };
  const sig = (s) => {  // 表單序號與有效 action 來源的雜湊（FNV-1a），不含值
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
  };

  // 由表單與提交者組出一次嘗試（值在這裡同步讀）。不合格回 null
  const fromForm = (form, sub) => {
    const dest = destination(form, sub);
    if (!dest) return null;
    const list = controls(form);
    const pws = passwords(list);
    if (pws.length > 1) return null;  // 改密碼、註冊頁
    const idx = [...document.forms].indexOf(form);
    const form_sig = sig(`${idx}|${dest}`);
    if (pws.length === 1) {
      const pw = pws[0];
      if (isCaptcha(pw) || pw.readOnly || pw.disabled) return null;
      const password = val(pw);
      if (!password || password.length > MAX_PASS) return null;
      const u = pickUser(list, pw);
      const username = u ? val(u) : null;
      if (username && username.length > MAX_USER) return null;
      return username ? { step: "full", form_sig, username, password, flags: [] }
        : { step: "password", form_sig, password, flags: ["password_only"] };
    }
    // 多步登入的帳號步：沒有密碼欄、只有一個看得見的帳號欄（§3.5，只限頂層框架）
    if (!auth.top) return null;
    const users = list.filter((e) => isUserLike(e) && visible(e));
    if (users.length !== 1 || !readable(users[0])) return null;
    const username = val(users[0]);
    if (!username || username.length > MAX_USER) return null;
    return { step: "username", form_sig, username, flags: [] };
  };
  // 沒有 form 的 SPA：只接受焦點在看得見的密碼欄上按 Enter；目的地未知（dest_unknown）
  const fromLoose = (pw) => {
    if (!readable(pw)) return null;
    const pws = [...document.querySelectorAll("input")].filter((e) => !e.form && isPassword(e) && visible(e));
    if (pws.length > 1) return null;
    const password = val(pw);
    if (!password || password.length > MAX_PASS) return null;
    const u = pickUser([...document.querySelectorAll("input")].filter((e) => !e.form), pw);
    const username = u ? val(u) : null;
    if (username && username.length > MAX_USER) return null;
    const form_sig = sig(`-1|${auth.origin}`);
    return username ? { step: "full", form_sig, username, password, flags: ["dest_unknown"] }
      : { step: "password", form_sig, password, flags: ["password_only", "dest_unknown"] };
  };

  const flush = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    if (!auth) return;  // 沒有授權（已撤銷）：不送；reads 已計入，背景會看到短少而判不完整
    const msg = { sbEnroll: 1, gen: auth.gen, seq: p.seq, reads, step: p.a.step, form_sig: p.a.form_sig,
                  flags: p.a.flags, submit_seen: p.submit_seen === true };
    if (p.a.username != null) msg.username = p.a.username;
    if (p.a.password != null) msg.password = p.a.password;
    p.a = null;
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {}
  };
  const attempt = (key, a) => {
    if (!a) return;
    flush();  // 前一個還沒送出的先送
    reads += 1;
    pending = { seq: ++seq, a, key, submit_seen: false, timer: setTimeout(flush, FLUSH_MS) };
  };
  // 去重只認「同一個動作的衍生事件」（R27-4）：Enter 的隱式提交在同一動作裡模擬點擊預設按鈕（detail=0、沒有指標座標）。
  // 使用者另外的點擊（detail≥1）或鍵盤啟動按鈕，一律是新的嘗試，不看時間間隔
  const endEnter = () => { clearTimeout(enterTimer); enterTimer = null; enterFor = null; };
  const startEnter = (key) => {
    endEnter();
    enterFor = key;
    enterTimer = setTimeout(endEnter, ENTER_HOLD_MS);
  };
  const derivedFromEnter = (form, e) => enterFor !== null && enterFor === form && e.detail === 0;

  const onClick = (e) => {
    if (!e.isTrusted || expired()) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    const t = path.find((n) => n instanceof Element);
    if (!t) return;
    const btn = t.closest("button, input");
    if (!btn || btn.closest("a") || !isSubmitBtn(btn)) return;  // a 連結、type=button／reset、[role=button] 都不算
    const name = [btn.textContent, getAttr.call(btn, "value"), getAttr.call(btn, "aria-label"), btn.id,
                  getAttr.call(btn, "name"), getAttr.call(btn, "class")].filter(Boolean).join(" ");
    if (NAMED.test(name)) return;
    const form = btn.form;
    if (!form) return;  // 沒有表單關聯：分不出哪個按鈕是登入
    if (derivedFromEnter(form, e)) return;
    attempt(form, fromForm(form, btn));
  };
  const onKey = (e) => {
    if (!e.isTrusted || e.key !== "Enter" || e.isComposing || expired()) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    const el = path[0];
    if (!(el instanceof HTMLInputElement) || !visible(el)) return;
    if (!(isPassword(el) || isUserLike(el))) return;
    const form = el.form;
    if (e.repeat) return;  // 按住 Enter 的自動重複不是新的動作
    if (!form) {
      if (!isPassword(el)) return;
      startEnter("loose");
      attempt("loose", fromLoose(el));
      return;
    }
    const sub = implicitSubmitter(form);
    if (sub === undefined) return;  // 瀏覽器不會提交
    startEnter(form);
    attempt(form, fromForm(form, sub));
  };
  const onSubmit = (e) => {
    if (pending && pending.key === e.target) { pending.submit_seen = true; flush(); }
  };
  const onKeyUp = (e) => { if (e.isTrusted && e.key === "Enter" && enterFor !== null) setTimeout(endEnter, 0); };
  // 離開文件：先送出延遲中的捕獲，再告訴背景這份文件總共讀到幾個（背景據此確認全部送達，R27-1）
  const onHide = (e) => {
    if (!e.isTrusted) return;
    flush();
    if (everAuth && auth) { try { chrome.runtime.sendMessage({ sbEnrollBye: 1, reads }).catch(() => {}); } catch {} }
  };

  // 提示列（頂層文件）：closed shadow root，只是告知，不是安全邊界（§3.1）。「取消補登」只接受可信點擊
  const banner = (b) => {
    if (!b || document.getElementById(BANNER_ID) || !document.documentElement) return;
    const host = document.createElement("div");
    host.id = BANNER_ID;
    for (const [k, v] of [["all", "initial"], ["position", "fixed"], ["top", "0"], ["left", "0"], ["right", "0"],
                          ["z-index", "2147483647"], ["display", "block"], ["pointer-events", "none"]]) host.style.setProperty(k, v, "important");
    const root = host.attachShadow({ mode: "closed" });
    const bar = document.createElement("div");
    // 提示列不擋頁面：只有「取消補登」接收滑鼠事件，其餘點擊穿過到頁面（owner 要能操作整個頁面）
    bar.setAttribute("style", "pointer-events:none;display:flex;gap:12px;align-items:center;padding:4px 12px;background:#fff3cd;color:#3d2f00;opacity:.95;" +
      "font:14px -apple-system,system-ui,sans-serif;border-bottom:1px solid #d4b106");
    const text = document.createElement("span");
    text.textContent = `secret-broker 補登中：請確認網址是 ${b.origin}${b.insecure ? "（未加密）" : ""}，自己登入一次；之後會另外驗證才記下。`;
    const cancel = document.createElement("button");
    cancel.textContent = "取消補登";
    cancel.setAttribute("style", "pointer-events:auto");
    cancel.addEventListener("click", (e) => {
      if (!e.isTrusted || !auth) return;
      chrome.runtime.sendMessage({ sbEnrollCancel: 1 }).catch(() => {});
      stop();  // 方向安全：先停止這份文件的捕獲
    });
    bar.append(text, cancel);
    root.append(bar);
    document.documentElement.appendChild(host);
  };

  const listen = () => {
    addEventListener("click", onClick, true);
    addEventListener("keydown", onKey, true);
    addEventListener("keyup", onKeyUp, true);
    addEventListener("submit", onSubmit, true);
    addEventListener("pagehide", onHide, true);
  };
  const unlisten = () => {
    removeEventListener("click", onClick, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("keyup", onKeyUp, true);
    removeEventListener("submit", onSubmit, true);
  };
  // 撤銷（背景的 enroll_stop、取消、期滿）：先把延遲中的捕獲送出（還有授權時），再移除監聽、清掉授權、移除提示列。
  // 回報這份文件讀到的嘗試數（只有數目），背景用它確認讀到的都已送達（R27-1）
  const stop = () => {
    flush();
    auth = null;
    if (pending) { clearTimeout(pending.timer); pending.a = null; pending = null; }
    endEnter();
    unlisten();
    document.getElementById(BANNER_ID)?.remove();
    return { reads };
  };
  G.__sbEnrollStop = stop;

  const ask = () => chrome.runtime.sendMessage({ sbEnrollAuth: 1 }).then((r) => r, () => null).then((r) => {
    if (!r || r.ok !== true || typeof r.gen !== "string" || typeof r.deadline !== "number" || Date.now() > r.deadline) {
      stop();
      return false;
    }
    auth = { enroll: r.enroll, gen: r.gen, origin: r.origin, deadline: r.deadline, top: r.top === true };
    everAuth = true;
    listen();
    if (auth.top) banner(r.banner);
    // 期滿自己停（§3.2 第 3 點）
    setTimeout(() => { if (auth && Date.now() > auth.deadline) stop(); }, Math.max(0, r.deadline - Date.now() + 50));
    return true;
  });

  listen();  // 同步掛上；授權前 expired() 為真，動作一律作廢
  ask().then(readyResolve);
  G.__sbEnrollReask = () => {
    auth = null;
    G.__sbEnrollReady = new Promise((r) => { readyResolve = r; });
    ask().then(readyResolve);
  };
  // 往返快取：進快取時清掉授權；恢復時重新詢問（§3.2 第 5 點）
  // （onHide 已在 listen() 掛上，先執行：送出延遲中的捕獲與讀到的數目）
  addEventListener("pagehide", (e) => { if (e.isTrusted && e.persisted) auth = null; });
  addEventListener("pageshow", (e) => {
    if (!e.isTrusted || !e.persisted) return;
    G.__sbEnrollReady = new Promise((r) => { readyResolve = r; });
    ask().then(readyResolve);
  });
})();
