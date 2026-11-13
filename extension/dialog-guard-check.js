// dialog-guard.js 的搭檔（ISOLATED world、document_start、所有框架）：問背景這份文件要不要保護，
// 把答案經 DOM 事件交給 MAIN world 的 dialog-guard.js。答案只由背景依 sender.tab／sender.origin 決定（R11-1）。
// 握手：兩邊都在頁面程式執行前跑；這裡產生一次性隨機值送過去，對方收到後回 ack，之後就不再回應，
// 所以頁面程式開始執行時已經拿不到這個值，偽造的判定事件會被忽略。
(() => {
  const nonce = crypto.randomUUID() + crypto.randomUUID();
  const hello = () => document.dispatchEvent(new CustomEvent("__sb_guard_a__", { detail: nonce }));
  const stop = () => {
    document.removeEventListener("__sb_guard_b__", hello);
    document.removeEventListener("__sb_guard_ack__", stop);
  };
  document.addEventListener("__sb_guard_b__", hello);
  document.addEventListener("__sb_guard_ack__", stop);
  hello();
  chrome.runtime.sendMessage({ sbDialogGuard: 1 }).then((r) => r, () => null).then((r) => {
    stop();
    const guard = !!r && r.guard === true && typeof r.guardId === "string";
    // 工作世代（R12-2）只放在擴充的 ISOLATED world，頁面讀不到；背景同時記下這份文件屬於這個工作。
    // 保留期（D10）只給保護、不給世代：這份文件不屬於進行中的工作
    if (guard && typeof r.gen === "string" && globalThis.__sbGen === undefined) {
      globalThis.__sbGen = r.gen;
      globalThis.__sbDocGen = r.gen;
      globalThis.__sbClean = false;
    }
    // 保護擁有者 guardId 交給 MAIN 的 dialog-guard.js（頁面看得到；只是擁有者標籤，背景不接受頁面給的任何值）
    document.dispatchEvent(new CustomEvent("__sb_guard_verdict__", { detail: guard ? `${nonce}:guard:${r.guardId}` : `${nonce}:native` }));
  });
})();

// 往返快取（R12-1、R13-1）：與 background.js 的 pageOp 的 life() 相同（共用旗標，同一份文件只掛一次）。
// 進快取時讓工作世代失效；恢復時向背景詢問。要不要清理只由背景的可信記錄（documentId → 世代）決定：
// 從未屬於工作的文件背景查不到，什麼都不做。
// 0.2.9（R18-1）：曾屬於工作而且沒有被原地清乾淨的文件（或已離開的文件），pagehide 與 pageshow（persisted）時
// 同步重建遮罩，不等背景回覆。遮罩的建立方式與 background.js pageOp 的 sbMask 相同，改一處要兩處一起改
(() => {
  const G = globalThis;
  if (G.__sbLife) return;
  G.__sbLife = true;
  const sbMask = (id) => {
    if (document.getElementById(id) || !document.documentElement) return;
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
  const masked = () => G.__sbLeft || (G.__sbDocGen !== undefined && !G.__sbClean);
  // 0.2.10（R19-1）：已離開的文件不留任何網站內容；恢復時同步換成 about:blank（與 background.js pageOp 的 wipe／life 相同）
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
  const veil = () => {
    if (!masked()) return;
    sbMask("__sb_login_mask__");
    requestAnimationFrame(() => { if (masked()) sbMask("__sb_login_mask__"); });
  };
  addEventListener("pagehide", (e) => { if (e.isTrusted && e.persisted) { G.__sbGen = null; veil(); if (G.__sbLeft) wipe(); } });
  addEventListener("pageshow", (e) => {
    if (!e.isTrusted || !e.persisted) return;
    veil();
    if (G.__sbLeft) {
      wipe();
      try { location.replace("about:blank"); } catch {}
    }
    chrome.runtime.sendMessage({ sbLifecycle: 1 }).then((r) => {
      if (r && r.job === true && typeof r.gen === "string" && G.__sbDocGen === r.gen) G.__sbGen = r.gen;
    }, () => {});
  });
})();
