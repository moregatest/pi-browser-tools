#!/usr/bin/env node
// Usage: browser-nav.js <url> [--new] [--reload] [--host <host>]   (navigate the active tab; --new opens a tab)
//   --host <host>：只操作網址 host 相符的分頁（找不到就結束碼 3、URL_MISMATCH），不用最後一個分頁
//   env PI_BROWSER_PORT=<port>  CDP port (default 9222)
//   env PI_BROWSER_TARGET_ID=<CDP target id>：只操作這個分頁（同主機的其他分頁不算；找不到或 host 不符結束碼 3）
//   env PI_BROWSER_TIMEOUT_MS=<ms>  整支指令的時間上限（預設 30000），超時結束碼 124

import { argValue, connect, deadline, exitNoHost, guard, pickPage, withoutArg } from "./lib/connect.js";

guard("nav");
deadline("nav");

const raw = process.argv.slice(2);
const host = argValue(raw, "--host");
const args = withoutArg(raw, "--host");
const newTab = args.includes("--new");
const reload = args.includes("--reload");
const url = args.find((a) => !a.startsWith("--"));

if (!url || (raw.includes("--host") && !host)) {
	console.log("Usage: browser-nav.js <url> [--new] [--reload] [--host <host>]");
	console.log("\nExamples:");
	console.log("  browser-nav.js https://example.com          # Navigate current tab");
	console.log("  browser-nav.js https://example.com --new    # Open in new tab");
	console.log("  browser-nav.js https://example.com --reload # Navigate and force reload");
	console.log("  browser-nav.js https://example.com/a --host example.com  # Navigate the example.com tab");
	process.exit(1);
}

const b = await connect();

if (newTab) {
	const p = await b.newPage();
	await p.goto(url, { waitUntil: "domcontentloaded" });
	console.log("✓ Opened:", url);
} else {
	// PI_BROWSER_TARGET_ID 綁定的分頁還在 about:blank 時也可以導（代登入召喚先開的空白分頁）
	const p = await pickPage(b, host, { allowBlank: true });
	if (!p) {
		if (host) await exitNoHost(b, host);
		console.error("✗ No active tab found");
		process.exit(1);
	}
	await p.goto(url, { waitUntil: "domcontentloaded" });
	if (reload) {
		await p.reload({ waitUntil: "domcontentloaded" });
	}
	console.log("✓ Navigated to:", url);
}

await b.disconnect();
