#!/usr/bin/env node
// Usage: browser-view.js [url-substring] [--print]   (open a live, clickable view of a :9222 tab in your own Chrome)
//   在你平常用的 Chrome 開啟 :9222 分頁的開發者工具；左側即時畫面可點選、捲動、打字。
//   headless 模式下想看 agent 在做什麼就用這個。
//   url-substring：只挑網址含這段文字的分頁（預設最近使用的分頁）
//   --print：只印出網址，不自動開啟

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const printOnly = args.includes("--print");
const filter = args.find((a) => !a.startsWith("--"));
if (args.some((a) => a.startsWith("--") && a !== "--print")) {
	console.log("Usage: browser-view.js [url-substring] [--print]");
	process.exit(1);
}

let list;
try {
	const r = await fetch("http://localhost:9222/json/list", { signal: AbortSignal.timeout(5000) });
	list = await r.json();
} catch (e) {
	console.error("✗ Could not reach Chrome on :9222:", e.message);
	console.error("  Run: pi-browser start");
	process.exit(1);
}

const pages = list.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
const target = filter ? pages.find((t) => t.url.includes(filter)) : pages[0];
if (!target) {
	console.error(`✗ No tab found${filter ? ` matching "${filter}"` : ""}`);
	for (const t of pages) console.error(`  - ${t.url}`);
	process.exit(1);
}

// 用 :9222 內建的開發者工具前端（不依賴外部網站）
const url = `http://localhost:9222/devtools/inspector.html?ws=localhost:9222/devtools/page/${target.id}`;
console.log(`✓ ${target.title || target.url}`);
console.log(`  ${url}`);
if (printOnly) process.exit(0);
// 用 macOS open 交給你平常的 Chrome（不是 :9222 那個）
execFileSync("open", ["-a", "Google Chrome", url]);
console.log("  opened in your Chrome — the live screen is on the left of DevTools (click / scroll / type works)");
