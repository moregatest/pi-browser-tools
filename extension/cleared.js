// 退到擴充頁（C1，0.2.8）後顯示的頁面：只顯示站名與一個「回到登入頁」按鈕。
// 網址參數 o＝工作來源、h＝綁定時的網址（來源＋路徑，不含查詢字串）。h 必須是 http(s) 而且和 o 同來源才顯示按鈕。
// 按鈕是使用者自己的動作：只是一般的導頁，擴充不會再填任何值。
(() => {
  const q = new URLSearchParams(location.search);
  let origin = null;
  let home = null;
  try {
    const o = new URL(q.get("o") || "");
    if (/^https?:$/.test(o.protocol)) origin = o.origin;
    const h = new URL(q.get("h") || "");
    if (origin && /^https?:$/.test(h.protocol) && h.origin === origin) home = h.origin + h.pathname;
  } catch {}
  document.getElementById("site").textContent = origin ? `網站：${origin}` : "";
  const back = document.getElementById("back");
  if (home) {
    back.hidden = false;
    back.addEventListener("click", () => { location.href = home; });
  }
})();
