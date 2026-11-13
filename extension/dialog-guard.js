// 登入工作分頁的對話框保護（E1 D5、R10-1、R11-1），MAIN world、document_start、所有框架。
// 由 background.js 在有工作的期間對工作來源動態註冊；與 dialog-guard-check.js（ISOLATED world）成對。
//
// 「這份文件要不要保護」只由背景的工作狀態決定（R11-1）：
//   1. 一開始是「待定」：alert 先排隊、confirm／prompt 回取消、beforeunload 也擋，
//      因為工作分頁登入後的首頁常在載入第一時間就跳 alert，等不及背景回答（非工作文件只受影響這幾毫秒）。
//   2. dialog-guard-check.js 問背景（chrome.runtime.sendMessage）；背景用 sender.tab、sender.origin 這兩個
//      頁面改不了的欄位，比對記憶體裡的工作分頁，回答 guard 或 native。
//   3. guard：維持保護。native：完全還原原本的函式與監聽器，排隊的 alert 照原樣補跳出來。
//      背景 3 秒內沒回答也還原（寧可不保護，也不影響非工作分頁）。
// 判定結果經 DOM 事件從 ISOLATED 傳到 MAIN；兩支腳本在頁面任何程式執行之前，先用一次性隨機值握手，
// 頁面不知道這個值，偽造的事件一律不理。頁面就算自己改 alert，也只影響它自己，拿不到工作身分。
// 已保護的文件之後由背景的 pageGuard 呼叫 window[Symbol.for("sb.dialogGuard")].restore(擁有者) 還原。
// 擁有者（X2H、R13-2）：判定 guard 時一併收到工作的保護擁有者 guardId，記在閉包；restore 帶的擁有者不符就什麼都不做，
// 晚到的舊工作還原撤銷不了新工作。不帶參數的 restore() 是頁面自己還原（只影響它自己）。
// 本檔的安裝程式與 background.js 的 pageGuard 相同，改一處要兩處一起改。
(() => {
  const SYM = Symbol.for("sb.dialogGuard");
  if (window[SYM]) return;
  const names = ["alert", "confirm", "prompt"];
  const saved = {};
  for (const k of names) saved[k] = Object.getOwnPropertyDescriptor(window, k);
  const orig = (k) => saved[k] && saved[k].value;
  let state = "pending";
  let own = null;
  const queued = [];
  const wrap = {
    alert: function alert(...a) {
      if (state === "native") return orig("alert").apply(window, a);
      if (state === "pending") queued.push(a);
    },
    confirm: function confirm(...a) { return state === "native" ? orig("confirm").apply(window, a) : false; },
    prompt: function prompt(...a) { return state === "native" ? orig("prompt").apply(window, a) : null; },
  };
  for (const k of names) Object.defineProperty(window, k, { value: wrap[k], configurable: true, writable: true });
  const onBeforeUnload = (e) => { if (state !== "native") e.stopImmediatePropagation(); };
  window.addEventListener("beforeunload", onBeforeUnload, true);

  let nonce = null;
  let timer = null;
  const onHello = (e) => {
    if (nonce !== null || typeof e.detail !== "string" || e.detail.length < 30) return;
    nonce = e.detail;
    document.removeEventListener("__sb_guard_a__", onHello);
    document.dispatchEvent(new CustomEvent("__sb_guard_ack__"));
  };
  const finish = () => {
    clearTimeout(timer);
    document.removeEventListener("__sb_guard_a__", onHello);
    document.removeEventListener("__sb_guard_verdict__", onVerdict);
  };
  const restore = (o) => {
    if (o !== undefined && o !== own) return false;
    state = "native";
    finish();
    for (const k of names) {
      if (saved[k]) Object.defineProperty(window, k, saved[k]);
      else delete window[k];
    }
    window.removeEventListener("beforeunload", onBeforeUnload, true);
    delete window[SYM];
    return true;
  };
  const guard = (o) => { state = "guard"; own = o; queued.length = 0; finish(); return true; };
  const toNative = () => {
    const q = queued.splice(0);
    restore(own);
    for (const a of q) setTimeout(() => orig("alert").apply(window, a), 0);
  };
  const onVerdict = (e) => {
    if (nonce === null || state !== "pending" || typeof e.detail !== "string") return;
    if (e.detail === `${nonce}:native`) { toNative(); return; }
    const head = `${nonce}:guard:`;
    if (e.detail.startsWith(head) && e.detail.length > head.length) guard(e.detail.slice(head.length));
  };
  Object.defineProperty(window, SYM, { value: { restore, guard }, configurable: true });
  document.addEventListener("__sb_guard_a__", onHello);
  document.addEventListener("__sb_guard_verdict__", onVerdict);
  document.dispatchEvent(new CustomEvent("__sb_guard_b__"));  // 對方若已先跑，會回送一次 hello
  timer = setTimeout(() => { if (state === "pending") toNative(); }, 3000);
})();
