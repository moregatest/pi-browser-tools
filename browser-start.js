#!/usr/bin/env node
// Usage: browser-start.js [--fresh] [--profile] [--headed]   (launch Chrome on PI_BROWSER_PORT, default :9222)
//   default:     copy your real Chrome profile (cookies, logins)
//   --fresh:     empty profile: the profile dir is deleted first (no cookies, no saved logins)
//   env PI_BROWSER_PORT=<port>          CDP port (default 9222)
//   env PI_BROWSER_PROFILE_DIR=<dir>    profile dir (default ~/.cache/browser-tools; must be
//                                       ~/.cache/browser-tools* — it gets wiped by --fresh / stop --purge)
//   env PI_BROWSER_HIDE_COOKIE=1        every tab (incl. ones opened later) reads document.cookie as ""
//                                       (writes still work); a background guard keeps it applied
//   headless 時背景守護程式也會自動關掉頁面對話框（alert／beforeunload 確定，confirm／prompt 取消），
//   否則沒人關的對話框會讓分頁的 eval、截圖永遠沒有回應
//   --profile:   accepted alias for the default (kept for backwards compat)
//   --headed:    show a Chrome window (default is headless, so it never steals focus;
//                watch / click it with `pi-browser view`). Env PI_BROWSER_HEADED=1 does the same.

import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { assertSafeProfileDir, BROWSER_URL, guard, PORT, profileDir, UnsafeProfileDir } from "./lib/connect.js";

guard("start");

const useProfile = !process.argv.slice(2).includes("--fresh");
const explicitProfile = process.argv.includes("--profile");
const headed = process.argv.includes("--headed") || process.env.PI_BROWSER_HEADED === "1";

for (const arg of process.argv.slice(2)) {
	if (arg !== "--fresh" && arg !== "--profile" && arg !== "--headed") {
		console.log("Usage: browser-start.js [--fresh] [--profile] [--headed]");
		console.log("\nOptions:");
		console.log("  --fresh    Empty profile (clean session, no cookies/logins)");
		console.log("  --profile  Copy your default Chrome profile (this is now the default; kept as an alias)");
		console.log("  --headed   Show a Chrome window (default: headless; watch it with `pi-browser view`)");
		process.exit(1);
	}
}

const hideCookie = process.env.PI_BROWSER_HIDE_COOKIE === "1";
// headless 沒有人能關對話框，一律由守護程式處理
const dismissDialogs = !headed;
const needGuard = hideCookie || dismissDialogs;
const guardFlags = [...(hideCookie ? ["--hide-cookie"] : []), ...(dismissDialogs ? ["--dismiss-dialogs"] : [])];

// 設定檔目錄會被 rsync --delete 或 --fresh 清掉，先確認它是安全的位置
let SCRAPING_DIR;
try {
	SCRAPING_DIR = assertSafeProfileDir(profileDir());
} catch (e) {
	if (!(e instanceof UnsafeProfileDir)) throw e;
	console.error(`✗ ${e.message}`);
	process.exit(2);
}

const GUARD_PID = () => join(SCRAPING_DIR, "cookie-guard.pid");

function guardAlive() {
	try {
		process.kill(Number(readFileSync(GUARD_PID(), "utf8")), 0);
		return true;
	} catch {
		return false;
	}
}

/** 起背景守護程序（遮 document.cookie 讀取、自動關對話框）；等它就緒才回來。 */
async function ensureCookieGuard(flags) {
	if (guardAlive()) return true;
	rmSync(GUARD_PID(), { force: true });
	const { webSocketDebuggerUrl } = await (await fetch(`${BROWSER_URL}/json/version`)).json();
	const script = join(dirname(fileURLToPath(import.meta.url)), "lib", "cookie-guard.js");
	spawn(process.execPath, [script, webSocketDebuggerUrl, GUARD_PID(), ...flags], { detached: true, stdio: "ignore" }).unref();
	for (let i = 0; i < 50; i++) {
		if (existsSync(GUARD_PID())) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

// Check if already running on PI_BROWSER_PORT（已在執行就沿用，不清空）
let running = null;
try {
	const browser = await puppeteer.connect({
		browserURL: BROWSER_URL,
		defaultViewport: null,
	});
	running = (await browser.userAgent()).includes("HeadlessChrome") ? "headless" : "headed";
	await browser.disconnect();
} catch {}
if (running) {
	console.log(`✓ Chrome already running on :${PORT} (${running})`);
	// 沿用已在執行的 Chrome：依它實際是不是 headless 決定要不要關對話框
	const runFlags = [...(hideCookie ? ["--hide-cookie"] : []), ...(running === "headless" ? ["--dismiss-dialogs"] : [])];
	if (runFlags.length && !(await ensureCookieGuard(runFlags))) {
		console.error("✗ cookie guard did not start");
		process.exit(1);
	}
	if ((running === "headless") === headed) {
		console.log(`  note: you asked for ${headed ? "headed" : "headless"}; quit the :${PORT} Chrome first to switch`);
	}
	process.exit(0);
}

// --fresh 真的清空：以前只是不做 rsync，之前複製進來的 cookie 與密碼都還在
if (!useProfile) rmSync(SCRAPING_DIR, { recursive: true, force: true });

// Setup profile directory（只有自己讀得到）
mkdirSync(SCRAPING_DIR, { recursive: true, mode: 0o700 });
chmodSync(SCRAPING_DIR, 0o700);

// Remove SingletonLock to allow new instance
for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
	rmSync(`${SCRAPING_DIR}/${name}`, { force: true });
}

if (useProfile) {
	console.log("Syncing profile...");
	execFileSync(
		"rsync",
		[
			"-a",
			"--delete",
			"--exclude=SingletonLock",
			"--exclude=SingletonSocket",
			"--exclude=SingletonCookie",
			"--exclude=*/Sessions/*",
			"--exclude=*/Current Session",
			"--exclude=*/Current Tabs",
			"--exclude=*/Last Session",
			"--exclude=*/Last Tabs",
			`${process.env.HOME}/Library/Application Support/Google/Chrome/`,
			`${SCRAPING_DIR}/`,
		],
		{ stdio: "pipe" },
	);
}

// Start Chrome with flags to force new instance
spawn(
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	[
		`--remote-debugging-port=${PORT}`,
		`--user-data-dir=${SCRAPING_DIR}`,
		"--no-first-run",
		"--no-default-browser-check",
		// headless：不開視窗、不搶焦點；要看畫面用 `pi-browser view`
		...(headed ? [] : ["--headless=new", "--window-size=1280,900"]),
	],
	{ detached: true, stdio: "ignore" },
).unref();

// Wait for Chrome to be ready
let connected = false;
for (let i = 0; i < 30; i++) {
	try {
		const browser = await puppeteer.connect({
			browserURL: BROWSER_URL,
			defaultViewport: null,
		});
		await browser.disconnect();
		connected = true;
		break;
	} catch {
		await new Promise((r) => setTimeout(r, 500));
	}
}

if (!connected) {
	console.error("✗ Failed to connect to Chrome");
	process.exit(1);
}

if (needGuard && !(await ensureCookieGuard(guardFlags))) {
	console.error("✗ cookie guard did not start");
	process.exit(1);
}

console.log(
	`✓ Chrome started on :${PORT} (${headed ? "headed" : "headless — watch / click it with: pi-browser view"})${
		useProfile
			? " with your profile" + (explicitProfile ? " (--profile)" : "")
			: " with a fresh empty profile (--fresh)"
	}${hideCookie ? " — document.cookie reads hidden" : ""}${dismissDialogs ? " — page dialogs auto-dismissed" : ""}`,
);
