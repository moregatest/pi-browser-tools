#!/usr/bin/env node
// Usage: browser-cookies.js [--values] [--host <host>]   (list cookies of the current tab; values hidden unless --values)
//   預設只印名稱、網域與旗標；要看值必須加 --values。
//   --host <host>：只看網址 host 相符的分頁（找不到就結束碼 3、URL_MISMATCH）
//   代登入專用的 :9223 一律拒絕（結束碼 77），避免登入 cookie 被讀出。
//   env PI_BROWSER_PORT=<port>  CDP port (default 9222)

import { argValue, connect, exitNoHost, guard, pickPage, PORT, withoutArg } from "./lib/connect.js";

// 代登入專用 Chrome 的埠；它的 cookie 就是後台登入狀態
const LOGIN_PORT = 9223;

guard("cookies");
if (PORT === LOGIN_PORT) {
	console.error(`✗ cookies is refused on :${LOGIN_PORT} (the SiteOffice login browser)`);
	process.exit(77);
}

const raw = process.argv.slice(2);
const host = argValue(raw, "--host");
const rest = withoutArg(raw, "--host");
const showValues = rest.includes("--values");
if (rest.some((a) => a !== "--values") || (raw.includes("--host") && !host)) {
	console.log("Usage: browser-cookies.js [--values] [--host <host>]");
	process.exit(1);
}

const b = await connect();

const p = await pickPage(b, host);

if (!p) {
	if (host) await exitNoHost(b, host);
	console.error("✗ No active tab found");
	process.exit(1);
}

const cookies = await p.cookies();

for (const cookie of cookies) {
	console.log(showValues ? `${cookie.name}: ${cookie.value}` : `${cookie.name}: <hidden; use --values>`);
	console.log(`  domain: ${cookie.domain}`);
	console.log(`  path: ${cookie.path}`);
	console.log(`  httpOnly: ${cookie.httpOnly}`);
	console.log(`  secure: ${cookie.secure}`);
	console.log("");
}

await b.disconnect();
