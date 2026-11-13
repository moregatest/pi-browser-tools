#!/usr/bin/env node
// Usage: browser-fill.js --selector '<css>' (--expect-origin <origin> | --expect-host <host>) --field <name>
//   (fill one input; value read from stdin, never printed)
//   值從 stdin 讀一行。值不進命令列參數（ps 看不到）、不印到 stdout／stderr。
//   --expect-origin https://a.example.com：只操作來源（scheme＋host＋非預設埠）完全相符的分頁，
//     同一個 host 的 http 分頁不算。必須是正規化的來源（小寫、無路徑、無預設埠）。代登入一律用這個。
//   --expect-host <host>：舊介面，只比 host（含非預設埠，例如 127.0.0.1:8080），不分 http／https。
//   兩者擇一。
//   --field password 時欄位必須是 type=password。
//   輸出一行並以結束碼表示結果：
//     0 FILLED <field>          寫入且長度相符
//     1 ERROR <例外類別>         連不上 Chrome 等例外（只印類別，不印訊息）
//     2 （用法錯誤或 stdin 沒有值）
//     3 URL_MISMATCH <hosts>    寫入前：沒有網域相符的分頁，值沒有交出去
//     4 NO_FIELD                找不到合格欄位（不是 input、hidden、readonly、disabled、密碼欄不是 password）
//     5 FILL_FAILED             寫入後長度不符（例如被 maxlength 截斷），已清空欄位
//     6 URL_MISMATCH <host>     寫入後分頁已不在 --expect-host（值已進過頁面），已盡量清空欄位
//    77 （被 PI_BROWSER_DENY 拒絕）
//   env PI_BROWSER_PORT=<port>  CDP port (default 9222)

// puppeteer 的 DEBUG 輸出會印出 CDP 訊息（含要填的值），所以在載入 puppeteer 前就清掉。
// 下面的靜態匯入只有 node 內建模組，puppeteer 由 connect() 動態載入。
delete process.env.DEBUG;

import { argValue, connect, guard, hostOf, originOf, pageHosts, pickPage } from "./lib/connect.js";

guard("fill");

const EXIT = { FILLED: 0, ERROR: 1, USAGE: 2, URL_MISMATCH_BEFORE: 3, NO_FIELD: 4, FILL_FAILED: 5, URL_MISMATCH_AFTER: 6 };
// 寫入後等頁面反應（例如 input 事件觸發的導頁）再驗一次網域
const SETTLE_MS = 300;
const OVERALL_TIMEOUT_MS = 30000;

// 任何例外只印類別名稱：例外訊息可能含值或 CDP 參數
function fatal(e) {
	const name = (e && e.constructor && e.constructor.name) || "Error";
	console.log(`ERROR ${/^\w+$/.test(name) ? name : "Error"}`);
	process.exit(EXIT.ERROR);
}
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
setTimeout(() => fatal({ constructor: { name: "Timeout" } }), OVERALL_TIMEOUT_MS).unref();

const args = process.argv.slice(2);
const selector = argValue(args, "--selector");
const expectHost = argValue(args, "--expect-host");
const expectOrigin = argValue(args, "--expect-origin");
const field = argValue(args, "--field");
const known = new Set(["--selector", "--expect-host", "--expect-origin", "--field"]);
const unknown = args.filter((a, i) => a.startsWith("--") && !known.has(a) && !known.has(args[i - 1]));
// 來源要剛好是 originOf 的輸出：寫成 HTTP://、帶路徑或預設埠都當用法錯誤，不猜
const originOk = expectOrigin === undefined || (/^https?:\/\//.test(expectOrigin) && originOf(expectOrigin) === expectOrigin);
if (!selector || !field || unknown.length || !/^[\w.-]+$/.test(field) || !!expectHost === !!expectOrigin || !originOk) {
	console.error(
		"Usage: browser-fill.js --selector '<css>' (--expect-origin <origin> | --expect-host <host>) --field <name>   (value on stdin)",
	);
	process.exit(EXIT.USAGE);
}
// 比對分頁用的函式與目標值：來源模式連 scheme 一起比
const keyOf = expectOrigin ? originOf : hostOf;

async function readValue() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const text = Buffer.concat(chunks).toString("utf8");
	const newline = text.indexOf("\n");
	const line = newline >= 0 ? text.slice(0, newline) : text;
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

let value = await readValue();
if (!value) {
	console.error("✗ no value on stdin");
	process.exit(EXIT.USAGE);
}
const wantLength = value.length;

const browser = await connect({ onError: fatal });

async function finish(code, line) {
	value = undefined;
	console.log(line);
	try {
		await browser.disconnect();
	} catch {}
	process.exit(code);
}

// 頁面內執行：找欄位、檢查資格、聚焦並清空。不把值傳進頁面。
function prepare(sel, wantPassword) {
	let el;
	try {
		el = document.querySelector(sel);
	} catch {
		return false;
	}
	if (!el || el.tagName !== "INPUT") return false;
	const type = (el.getAttribute("type") || "text").toLowerCase();
	if (type === "hidden" || el.disabled || el.readOnly) return false;
	if (wantPassword && el.type !== "password") return false;
	el.focus();
	el.value = "";
	el.dispatchEvent(new Event("input", { bubbles: true }));
	return document.activeElement === el;
}

function clear(sel) {
	try {
		const el = document.querySelector(sel);
		if (el && el.tagName === "INPUT") {
			el.value = "";
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		}
	} catch {}
}

const want = (expectOrigin || expectHost).toLowerCase();

// 1. 只挑來源（或舊介面的 host）相符的分頁
const page = await pickPage(browser, want, { by: keyOf });
if (!page) {
	await finish(EXIT.URL_MISMATCH_BEFORE, `URL_MISMATCH ${(await pageHosts(browser)).join(",") || "none"}`);
}

// 2. 欄位資格
if (!(await page.evaluate(prepare, selector, field === "password"))) {
	await finish(EXIT.NO_FIELD, "NO_FIELD");
}

// 寫入前最後確認一次網域（prepare 期間頁面可能被導走）
if (keyOf(page.url()) !== want) {
	await finish(EXIT.URL_MISMATCH_BEFORE, `URL_MISMATCH ${keyOf(page.url()) || "none"}`);
}

// 3. 用 CDP Input.insertText 寫入（觸發 beforeinput／input），再補發 change
const cdp = await page.createCDPSession();
await cdp.send("Input.insertText", { text: value });
value = undefined;
await cdp.detach().catch(() => {});
await page
	.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (el) el.dispatchEvent(new Event("change", { bubbles: true }));
	}, selector)
	.catch(() => {});

// 4. 寫入後再驗一次網域：已被導走就清空並結束碼 6（值已進過頁面）
await new Promise((r) => setTimeout(r, SETTLE_MS));
const after = keyOf(page.url());
if (after !== want) {
	await page.evaluate(clear, selector).catch(() => {});
	await finish(EXIT.URL_MISMATCH_AFTER, `URL_MISMATCH ${after || "none"}`);
}

// 5. 只比對長度，不讀回值本身
const gotLength = await page.evaluate((sel) => {
	const el = document.querySelector(sel);
	return el ? el.value.length : -1;
}, selector);
if (gotLength !== wantLength) {
	await page.evaluate(clear, selector).catch(() => {});
	await finish(EXIT.FILL_FAILED, "FILL_FAILED");
}

await finish(EXIT.FILLED, `FILLED ${field}`);
