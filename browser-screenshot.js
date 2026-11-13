#!/usr/bin/env node
// Usage: browser-screenshot.js [--host <host>]   (screenshot the active viewport; prints file path)
//   --host <host>：只截網址 host 相符的分頁（找不到就結束碼 3、URL_MISMATCH），不用最後一個分頁
//   env PI_BROWSER_PORT=<port>  CDP port (default 9222)
//   env PI_BROWSER_TIMEOUT_MS=<ms>  整支指令的時間上限（預設 30000），超時結束碼 124

import { tmpdir } from "node:os";
import { join } from "node:path";
import { argValue, connect, deadline, exitNoHost, guard, pickPage, withoutArg } from "./lib/connect.js";

guard("screenshot");
deadline("screenshot");

const raw = process.argv.slice(2);
const host = argValue(raw, "--host");
if (withoutArg(raw, "--host").length || (raw.includes("--host") && !host)) {
	console.log("Usage: browser-screenshot.js [--host <host>]");
	process.exit(1);
}

const b = await connect();

const p = await pickPage(b, host);

if (!p) {
	if (host) await exitNoHost(b, host);
	console.error("✗ No active tab found");
	process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `screenshot-${timestamp}.png`;
const filepath = join(tmpdir(), filename);

await p.screenshot({ path: filepath });

console.log(filepath);

await b.disconnect();
