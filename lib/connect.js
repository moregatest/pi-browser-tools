// 所有腳本共用：CDP 埠、設定檔目錄、指令拒絕清單、依網域挑分頁。
//
// 這個檔案只匯入 node: 內建模組；puppeteer 在 connect() 裡才動態載入，
// 讓 browser-fill.js 能在載入 puppeteer 之前先清掉 DEBUG（puppeteer 的除錯輸出
// 會印出 CDP 訊息，裡面有要填的值）。

import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

function readPort() {
	const raw = process.env.PI_BROWSER_PORT ?? "9222";
	const port = Number(raw);
	if (!/^\d+$/.test(raw) || port < 1024 || port > 65535) {
		console.error(`✗ PI_BROWSER_PORT 必須是 1024–65535 的數字（目前：${raw}）`);
		process.exit(2);
	}
	return port;
}

/** CDP 埠，預設 9222。 */
export const PORT = readPort();
export const BROWSER_URL = `http://127.0.0.1:${PORT}`;

export const CACHE_DIR = resolve(homedir(), ".cache");
export const DEFAULT_PROFILE_DIR = resolve(CACHE_DIR, "browser-tools");

/** 設定檔目錄：PI_BROWSER_PROFILE_DIR，預設 ~/.cache/browser-tools。 */
export function profileDir() {
	return resolve(process.env.PI_BROWSER_PROFILE_DIR || DEFAULT_PROFILE_DIR);
}

export class UnsafeProfileDir extends Error {}

/**
 * 設定檔目錄會被 rsync --delete、--fresh 與 stop --purge 整個清掉，
 * 所以只接受 ~/.cache/ 底下、名稱以 browser-tools 開頭、而且不是符號連結的目錄。
 */
export function assertSafeProfileDir(dir) {
	const target = resolve(dir);
	let cache = CACHE_DIR;
	try {
		cache = realpathSync(CACHE_DIR);
	} catch {}
	let parent = dirname(target);
	try {
		parent = realpathSync(parent);
	} catch {}
	if (parent !== cache) {
		throw new UnsafeProfileDir(`設定檔目錄必須直接位於 ${CACHE_DIR}/ 底下：${target}`);
	}
	if (!basename(target).startsWith("browser-tools")) {
		throw new UnsafeProfileDir(`設定檔目錄名稱必須以 browser-tools 開頭：${target}`);
	}
	try {
		if (lstatSync(target).isSymbolicLink()) {
			throw new UnsafeProfileDir(`設定檔目錄不可以是符號連結：${target}`);
		}
	} catch (e) {
		if (e instanceof UnsafeProfileDir) throw e;
		// 不存在：可以建立
	}
	return target;
}

/** PI_BROWSER_DENY（逗號或空白分隔）列出的指令直接拒絕，結束碼 77。 */
export function guard(command) {
	const denied = (process.env.PI_BROWSER_DENY || "")
		.split(/[\s,]+/)
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (denied.includes(command.toLowerCase())) {
		console.error(`✗ ${command} 被 PI_BROWSER_DENY 拒絕`);
		process.exit(77);
	}
}

/**
 * 整支指令的時間上限：PI_BROWSER_TIMEOUT_MS（預設 30000）。
 * 頁面主執行緒卡住（例如沒人關的對話框、同步請求）時 CDP 不會回應，
 * 沒有上限的話呼叫端會一直等。超時印 `✗ <指令> timeout` 並以結束碼 124 結束。
 */
export function deadline(command) {
	const raw = process.env.PI_BROWSER_TIMEOUT_MS ?? "30000";
	const ms = Number(raw);
	if (!/^\d+$/.test(raw) || ms < 1) {
		console.error(`✗ PI_BROWSER_TIMEOUT_MS 必須是正整數（目前：${raw}）`);
		process.exit(2);
	}
	setTimeout(() => {
		console.error(`✗ ${command} timeout after ${ms}ms（頁面可能卡住）`);
		process.exit(124);
	}, ms).unref();
}

/** 取 `--name value` 的值；沒有就回 undefined。 */
export function argValue(args, name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

/** 移除 `--name value` 這一組參數後的其餘參數。 */
export function withoutArg(args, name) {
	const i = args.indexOf(name);
	return i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
}

/** 網址的 host（含非預設埠），小寫；解析失敗回空字串。 */
export function hostOf(url) {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * 網址的來源（scheme://host[:非預設埠]），host 小寫；about:、data: 等沒有來源的網址與解析失敗回空字串。
 * 代登入用它比對分頁：同一個 host 的 http 與 https 是不同來源。
 */
export function originOf(url) {
	try {
		const origin = new URL(url).origin;
		return origin === "null" ? "" : origin.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * 連上 PI_BROWSER_PORT 的 Chrome。失敗時：預設印出說明並結束碼 1；
 * 給 onError 就交給呼叫者處理（browser-fill 只印例外類別）。
 */
export async function connect({ onError } = {}) {
	const { default: puppeteer } = await import("puppeteer-core");
	// 逾時計時器連上後要清掉，否則程序會多等滿 5 秒才結束
	let timer;
	try {
		return await Promise.race([
			puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null }),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 5000);
			}),
		]);
	} catch (e) {
		if (onError) return onError(e);
		console.error(`✗ Could not connect to browser on :${PORT}:`, e.message);
		console.error("  Run: pi-browser start");
		process.exit(1);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 挑要操作的分頁。給 host 就只挑網址相符的分頁（多個取最後一個），
 * 沒有相符的回 null；沒給 host 沿用舊行為：最後一個分頁。
 * by 決定怎麼從網址取出比對值：預設 hostOf；代登入填值傳 originOf，連 scheme 一起比。
 */
export async function pickPage(browser, host, { by = hostOf } = {}) {
	const pages = await browser.pages();
	if (!host) return pages.at(-1) ?? null;
	const want = host.toLowerCase();
	return pages.filter((p) => by(p.url()) === want).at(-1) ?? null;
}

/** 所有分頁的 host，給 URL_MISMATCH 訊息用。 */
export async function pageHosts(browser) {
	return [...new Set((await browser.pages()).map((p) => hostOf(p.url()) || p.url()))];
}

/** --host 找不到相符分頁時的統一輸出與結束碼 3。 */
export async function exitNoHost(browser, host) {
	console.log(`URL_MISMATCH ${(await pageHosts(browser)).join(",") || "none"}`);
	console.error(`✗ No tab whose host is ${host}`);
	await browser.disconnect();
	process.exit(3);
}
