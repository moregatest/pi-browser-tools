#!/usr/bin/env node
// Usage: browser-stop.js [--purge]   (close only the Chrome on PI_BROWSER_PORT; --purge also deletes its profile dir)
//   用 CDP Browser.close 關閉，不 kill 其他 Chrome。
//   --purge：關閉後刪除 PI_BROWSER_PROFILE_DIR（必須是 ~/.cache/browser-tools*）。
//   env PI_BROWSER_PORT=<port>          CDP port (default 9222)
//   env PI_BROWSER_PROFILE_DIR=<dir>    profile dir (default ~/.cache/browser-tools)

import { rmSync } from "node:fs";
import { assertSafeProfileDir, BROWSER_URL, connect, guard, PORT, profileDir, UnsafeProfileDir } from "./lib/connect.js";

guard("stop");

const args = process.argv.slice(2);
const purge = args.includes("--purge");
if (args.some((a) => a !== "--purge")) {
	console.log("Usage: browser-stop.js [--purge]");
	process.exit(2);
}

let dir = null;
if (purge) {
	try {
		dir = assertSafeProfileDir(profileDir());
	} catch (e) {
		if (!(e instanceof UnsafeProfileDir)) throw e;
		console.error(`✗ ${e.message}`);
		process.exit(2);
	}
}

async function up() {
	try {
		await fetch(`${BROWSER_URL}/json/version`, { signal: AbortSignal.timeout(1000) });
		return true;
	} catch {
		return false;
	}
}

if (await up()) {
	const browser = await connect();
	await browser.close(); // CDP Browser.close
	for (let i = 0; i < 40 && (await up()); i++) await new Promise((r) => setTimeout(r, 250));
	if (await up()) {
		console.error(`✗ Chrome on :${PORT} did not exit`);
		process.exit(1);
	}
	console.log(`✓ Chrome on :${PORT} closed`);
} else {
	console.log(`✓ No Chrome on :${PORT}`);
}

if (dir) {
	// Chrome 結束時可能還在寫檔，重試幾次
	for (let i = 0; ; i++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			break;
		} catch (e) {
			if (i >= 10) throw e;
			await new Promise((r) => setTimeout(r, 300));
		}
	}
	console.log(`✓ Removed ${dir}`);
}
