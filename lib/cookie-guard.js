#!/usr/bin/env node
// 由 browser-start.js 在背景啟動，跟著 Chrome 的生命週期。
// 用法：node lib/cookie-guard.js <browser websocket url> <pid 檔> [--hide-cookie] [--dismiss-dialogs]
//
// --hide-cookie（PI_BROWSER_HIDE_COOKIE=1）：
//   讓頁面裡的 document.cookie 讀取一律回空字串（寫入照舊），降低「用 eval 讀 cookie」
//   的外洩面。Page.addScriptToEvaluateOnNewDocument 只在注入它的 CDP 連線還在時有效，
//   所以這支程式要一直連著。
// --dismiss-dialogs（headless 時一律開）：
//   頁面的 alert／confirm／prompt／beforeunload 在 headless 下沒有人能關，會讓主執行緒停住，
//   之後 eval、截圖全部沒有回應（例：SiteOffice index.php 登入後的「請注意…」alert）。
//   DevTools 只對「開對話框當下已開 Page 網域」的連線回報對話框，事後附加的連線關不掉，
//   所以也要由這支常駐程式處理：alert、beforeunload 按確定；confirm、prompt 一律取消（安全預設）。
//
// - Target.setAutoAttach（waitForDebuggerOnStart）攔下之後才開的每個分頁，設定好才放行，
//   頁面自己的 script 不會搶在前面執行。
// - 啟動當下已存在的分頁逐一 attach；已卡住的分頁不回應，每個請求都有逾時，不拖住啟動。
// Chrome 結束時 WebSocket 關閉，這支程式跟著結束。
//
// 殘餘風險：同一使用者的程序直接連 CDP（Network.getCookies）仍讀得到；
// 動態建立的 about:blank iframe 是另一個 realm，可能取回原本的 getter。

import { rmSync, writeFileSync } from "node:fs";

const [wsUrl, pidFile, ...flags] = process.argv.slice(2);
if (!wsUrl || !pidFile) process.exit(2);
const hideCookie = flags.includes("--hide-cookie");
const dismissDialogs = flags.includes("--dismiss-dialogs");
// 卡住的分頁不會回應，每個請求最多等這麼久
const SEND_TIMEOUT_MS = 3000;

export const HIDE_COOKIE_SCRIPT = `(() => {
	const d = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
	if (!d || !d.configurable) return;
	Object.defineProperty(Document.prototype, "cookie", {
		configurable: false,
		enumerable: d.enumerable,
		get() { return ""; },
		set(v) { d.set.call(this, v); },
	});
})();`;

const ws = new WebSocket(wsUrl);
let nextId = 1;
const pending = new Map();
const attached = new Set();

function send(method, params = {}, sessionId) {
	const id = nextId++;
	ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	return new Promise((resolve) => {
		pending.set(id, resolve);
		setTimeout(() => {
			if (pending.delete(id)) resolve({ timeout: method });
		}, SEND_TIMEOUT_MS).unref();
	});
}

async function protect(sessionId, targetId) {
	attached.add(targetId);
	// 子分頁（例如 window.open）也自動 attach
	send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
	// Page.enable 之後才會收到 Page.javascriptDialogOpening
	await send("Page.enable", {}, sessionId);
	if (hideCookie) {
		await send("Page.addScriptToEvaluateOnNewDocument", { source: HIDE_COOKIE_SCRIPT }, sessionId);
		// 目前已載入的文件也立即套用
		await send("Runtime.evaluate", { expression: HIDE_COOKIE_SCRIPT }, sessionId);
	}
	await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
}

ws.addEventListener("message", (event) => {
	const msg = JSON.parse(String(event.data));
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg.result ?? msg.error);
		pending.delete(msg.id);
		return;
	}
	if (msg.method === "Page.javascriptDialogOpening" && dismissDialogs && msg.sessionId) {
		const accept = msg.params.type === "alert" || msg.params.type === "beforeunload";
		send("Page.handleJavaScriptDialog", { accept }, msg.sessionId);
		return;
	}
	if (msg.method === "Target.attachedToTarget") {
		const { sessionId, targetInfo, waitingForDebugger } = msg.params;
		if (targetInfo.type === "page" && !attached.has(targetInfo.targetId)) {
			protect(sessionId, targetInfo.targetId).catch(() => {});
		} else if (waitingForDebugger) {
			send("Runtime.runIfWaitingForDebugger", {}, sessionId);
		}
	}
});

ws.addEventListener("close", () => {
	rmSync(pidFile, { force: true });
	process.exit(0);
});
ws.addEventListener("error", () => process.exit(1));

ws.addEventListener("open", async () => {
	await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	await send("Target.setDiscoverTargets", { discover: true });
	const { targetInfos = [] } = await send("Target.getTargets");
	for (const t of targetInfos) {
		if (t.type === "page" && !attached.has(t.targetId)) {
			const r = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
			if (r && r.sessionId && !attached.has(t.targetId)) await protect(r.sessionId, t.targetId);
		}
	}
	// 寫 pid 檔表示已就緒；browser-start.js 等到它出現才結束
	writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
});
