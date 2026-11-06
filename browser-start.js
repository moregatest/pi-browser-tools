#!/usr/bin/env node
// Usage: browser-start.js [--fresh] [--profile] [--headed]   (launch Chrome on :9222)
//   default:     copy your real Chrome profile (cookies, logins)
//   --fresh:     empty profile (clean session, no cookies)
//   --profile:   accepted alias for the default (kept for backwards compat)
//   --headed:    show a Chrome window (default is headless, so it never steals focus;
//                watch / click it with `pi-browser view`). Env PI_BROWSER_HEADED=1 does the same.

import { spawn, execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

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

const SCRAPING_DIR = `${process.env.HOME}/.cache/browser-tools`;

// Check if already running on :9222
try {
	const browser = await puppeteer.connect({
		browserURL: "http://localhost:9222",
		defaultViewport: null,
	});
	const running = (await browser.userAgent()).includes("HeadlessChrome") ? "headless" : "headed";
	await browser.disconnect();
	console.log(`✓ Chrome already running on :9222 (${running})`);
	if ((running === "headless") === headed) {
		console.log(`  note: you asked for ${headed ? "headed" : "headless"}; quit the :9222 Chrome first to switch`);
	}
	process.exit(0);
} catch {}

// Setup profile directory
execSync(`mkdir -p "${SCRAPING_DIR}"`, { stdio: "ignore" });

// Remove SingletonLock to allow new instance
try {
	execSync(`rm -f "${SCRAPING_DIR}/SingletonLock" "${SCRAPING_DIR}/SingletonSocket" "${SCRAPING_DIR}/SingletonCookie"`, { stdio: "ignore" });
} catch {}

if (useProfile) {
	console.log("Syncing profile...");
	execSync(
		`rsync -a --delete \
			--exclude='SingletonLock' \
			--exclude='SingletonSocket' \
			--exclude='SingletonCookie' \
			--exclude='*/Sessions/*' \
			--exclude='*/Current Session' \
			--exclude='*/Current Tabs' \
			--exclude='*/Last Session' \
			--exclude='*/Last Tabs' \
			"${process.env.HOME}/Library/Application Support/Google/Chrome/" "${SCRAPING_DIR}/"`,
		{ stdio: "pipe" },
	);
}

// Start Chrome with flags to force new instance
spawn(
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	[
		"--remote-debugging-port=9222",
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
			browserURL: "http://localhost:9222",
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

console.log(
	`✓ Chrome started on :9222 (${headed ? "headed" : "headless — watch / click it with: pi-browser view"})${
		useProfile
			? " with your profile" + (explicitProfile ? " (--profile)" : "")
			: " with a fresh empty profile (--fresh)"
	}`,
);
