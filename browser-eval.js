#!/usr/bin/env node
// Usage: browser-eval.js [--host <host>] '<javascript>'   (eval JS in the active tab; runs in async context)
//   --host <host>：只在網址 host 相符的分頁執行（找不到就結束碼 3、URL_MISMATCH），不用最後一個分頁
//   env PI_BROWSER_TARGET_ID=<CDP target id>：只操作這個分頁（同主機的其他分頁不算；找不到或 host 不符結束碼 3）
//   env PI_BROWSER_PORT=<port>  CDP port (default 9222)
//   env PI_BROWSER_TIMEOUT_MS=<ms>  整支指令的時間上限（預設 30000），超時結束碼 124

import { argValue, connect, deadline, exitNoHost, guard, pickPage, withoutArg } from "./lib/connect.js";

guard("eval");
deadline("eval");

const raw = process.argv.slice(2);
const host = argValue(raw, "--host");
const code = withoutArg(raw, "--host").join(" ");
if (!code || (raw.includes("--host") && !host)) {
	console.log("Usage: browser-eval.js [--host <host>] 'code'");
	console.log("\nExamples:");
	console.log('  browser-eval.js "document.title"');
	console.log('  browser-eval.js "document.querySelectorAll(\'a\').length"');
	console.log('  browser-eval.js --host example.com "location.href"');
	process.exit(1);
}

const b = await connect();

const p = await pickPage(b, host);

if (!p) {
	if (host) await exitNoHost(b, host);
	console.error("✗ No active tab found");
	process.exit(1);
}

const result = await p.evaluate((c) => {
	const AsyncFunction = (async () => {}).constructor;
	return new AsyncFunction(`return (${c})`)();
}, code);

if (Array.isArray(result)) {
	for (let i = 0; i < result.length; i++) {
		if (i > 0) console.log("");
		for (const [key, value] of Object.entries(result[i])) {
			console.log(`${key}: ${value}`);
		}
	}
} else if (typeof result === "object" && result !== null) {
	for (const [key, value] of Object.entries(result)) {
		console.log(`${key}: ${value}`);
	}
} else {
	console.log(result);
}

await b.disconnect();
