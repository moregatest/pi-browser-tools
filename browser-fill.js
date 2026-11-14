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
//     3 URL_MISMATCH            寫入前：綁定的分頁不在預期來源，值沒有交出去（固定文字，不帶任何主機，R32-D3）；
//                               包括寫入那一刻欄位所屬文件的來源已不符（MF16，R33-D1）
//     4 NO_FIELD                找不到合格欄位（不是 input、hidden、readonly、disabled、密碼欄不是 password）；
//                               或驗證過的欄位所屬的文件在寫入前已換掉、欄位已脫離文件，值沒有交出去（MF16）
//     5 FILL_FAILED             值超過 maxlength（不寫入），或寫入後長度不符（已清空欄位）
//     6 URL_MISMATCH            寫入後分頁已不在預期來源（值已進過頁面），已盡量清空欄位
//     8 TAB_NOT_FOUND           PI_BROWSER_TARGET_ID 格式不符或找不到該分頁，值沒有交出去
//     9 TAB_UNBOUND             沒有 PI_BROWSER_TARGET_ID，值沒有交出去（MF13，R32-D2）
//    （7 TAB_AMBIGUOUS 已不再使用：沒有 id 一律 9）
//    77 （被 PI_BROWSER_DENY 拒絕）
//   env PI_BROWSER_PORT=<port>  CDP port (default 9222)
//   env PI_BROWSER_TARGET_ID=<id>  必填：只填這個 CDP target id 的分頁（secret-broker MF11／MF13）。
//     找不到就結束碼 8，來源不符就結束碼 3，不改挑同來源的其他分頁；沒給就結束碼 9。
//     「同來源只有一頁」不代表它是這次的登入頁（R32-D2），所以不再依來源挑頁。

// puppeteer 的 DEBUG 輸出會印出 CDP 訊息（含要填的值），所以在載入 puppeteer 前就清掉。
// 下面的靜態匯入只有 node 內建模組，puppeteer 由 connect() 動態載入。
delete process.env.DEBUG;

import { argValue, BOUND_TARGET_ID, connect, guard, hostOf, originOf, targetIdOf } from "./lib/connect.js";

guard("fill");

const EXIT = {
	FILLED: 0,
	ERROR: 1,
	USAGE: 2,
	URL_MISMATCH_BEFORE: 3,
	NO_FIELD: 4,
	FILL_FAILED: 5,
	URL_MISMATCH_AFTER: 6,
	TAB_NOT_FOUND: 8,
	TAB_UNBOUND: 9,
};
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

// 頁面內執行：找欄位、檢查資格、聚焦並清空，回傳欄位本身（成為該文件執行環境裡的 objectId）。
// 不把值傳進頁面。
const PREPARE = `(function (sel, wantPassword) {
	let el;
	try {
		el = document.querySelector(sel);
	} catch {
		return null;
	}
	if (!el || el.tagName !== "INPUT") return null;
	const type = (el.getAttribute("type") || "text").toLowerCase();
	if (type === "hidden" || el.disabled || el.readOnly) return null;
	if (wantPassword && el.type !== "password") return null;
	el.focus();
	el.value = "";
	el.dispatchEvent(new Event("input", { bubbles: true }));
	return el;
})`;

// 頁面內執行，this＝PREPARE 回傳的那個欄位（MF16，R33-D1）。
// 以 Runtime.callFunctionOn(objectId) 執行：函式跑在「欄位所屬文件」的執行環境裡，
// 文件換代時這個執行環境與 objectId 一起失效，CDP 呼叫直接失敗，函式不會在新文件執行。
// 函式內同步確認來源與欄位仍在文件上，才用原生 value setter 寫入並送 input／change；
// 確認與寫入在同一個工作裡完成，中間沒有可讓頁面導覽的空檔。
// 不用 Input.insertText：它寫進「當時的焦點」，不綁文件與欄位。
// SB_FILL_WRITE 是測試替身辨識寫值指令用的標記。
const WRITE = `function (mode, want, wantPassword, v) {
	/* SB_FILL_WRITE */
	const el = this;
	// location 不能被頁面改寫；origin／host 本來就是小寫序列化，直接比，不呼叫頁面可改的字串方法
	const here = mode === "origin" ? location.origin : location.host;
	if (here !== want) return "origin";
	if (!el.isConnected || el.ownerDocument !== document) return "detached";
	if (el.tagName !== "INPUT" || el.disabled || el.readOnly) return "detached";
	if ((el.getAttribute("type") || "text").toLowerCase() === "hidden") return "detached";
	if (wantPassword && el.type !== "password") return "detached";
	if (el.maxLength >= 0 && v.length > el.maxLength) return "too_long";
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	setter.call(el, v);
	// input／change 延到下一個工作才送：頁面的 input 處理器可能同步導頁，
	// 在這個函式裡送會讓執行環境當場消失、回覆遺失，就分不出「寫了」或「沒執行」。
	// 計時器屬於這份文件，文件換掉就不會再觸發，事件只會送到這個欄位。
	setTimeout(() => {
		el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	}, 0);
	return "ok";
}`;

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

// 1. 挑分頁：只用綁定 id 的分頁（R32-D2）；沒有 id 就不連分頁、不交值
if (!BOUND_TARGET_ID) await finish(EXIT.TAB_UNBOUND, "TAB_UNBOUND");
const pages = await browser.pages();
const page = /^[A-Fa-f0-9]{16,64}$/.test(BOUND_TARGET_ID) ? (pages.find((p) => targetIdOf(p) === BOUND_TARGET_ID) ?? null) : null;
if (!page) await finish(EXIT.TAB_NOT_FOUND, "TAB_NOT_FOUND");
// 來源不符只回固定文字：目前頁面的主機是外部文字，不帶出去（R32-D3）
if (keyOf(page.url()) !== want) await finish(EXIT.URL_MISMATCH_BEFORE, "URL_MISMATCH");

// 2. 交值用的 CDP 工作階段先建好：之後「找欄位」與「寫入」都在這個工作階段，objectId 才通用。
//    建立工作階段本身是非同步空檔，所以放在來源檢查與欄位驗證之前（R33-D1）。
const cdp = await page.createCDPSession();
const wantPassword = field === "password";
const mode = expectOrigin ? "origin" : "host";

// 3. 欄位資格：在頂層文件的預設執行環境裡找欄位，取得它的 objectId
let objectId = null;
try {
	const found = await cdp.send("Runtime.evaluate", {
		expression: `${PREPARE}(${JSON.stringify(selector)}, ${wantPassword})`,
		returnByValue: false,
	});
	if (!found.exceptionDetails && found.result && found.result.subtype === "node") objectId = found.result.objectId;
} catch {}
if (!objectId) {
	await cdp.detach().catch(() => {});
	await finish(EXIT.NO_FIELD, "NO_FIELD");
}

// 寫入前先看一次網域：不符就不交值（真正的保證在下面的 WRITE 裡）
if (keyOf(page.url()) !== want) {
	await cdp.detach().catch(() => {});
	await finish(EXIT.URL_MISMATCH_BEFORE, "URL_MISMATCH");
}

// 4. 交值：綁在已驗證的欄位與它的文件上，函式內確認來源後才寫入
let verdict = "error";
try {
	const r = await cdp.send("Runtime.callFunctionOn", {
		objectId,
		functionDeclaration: WRITE,
		arguments: [{ value: mode }, { value: want }, { value: wantPassword }, { value }],
		returnByValue: true,
	});
	if (!r.exceptionDetails && r.result && typeof r.result.value === "string") verdict = r.result.value;
} catch {
	// objectId 或執行環境已失效：文件在寫入前換掉了，函式沒有在任何新文件執行。
	// （函式本身不送事件、不導頁，正常情況下執行完一定收得到回覆；殘餘見 README）
	verdict = "gone";
}
value = undefined;
await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
await cdp.detach().catch(() => {});
if (verdict === "gone" || verdict === "error") {
	// 依目前分頁判斷是換到別的來源，還是同來源換了文件；都沒有交值。
	// 分頁網址由事件更新，稍等一下再讀，代碼才穩定
	await new Promise((r) => setTimeout(r, SETTLE_MS));
	const now = keyOf(page.url());
	await finish(now !== want ? EXIT.URL_MISMATCH_BEFORE : EXIT.NO_FIELD, now !== want ? "URL_MISMATCH" : "NO_FIELD");
}
if (verdict === "origin") await finish(EXIT.URL_MISMATCH_BEFORE, "URL_MISMATCH");
if (verdict === "detached") await finish(EXIT.NO_FIELD, "NO_FIELD");
if (verdict === "too_long") await finish(EXIT.FILL_FAILED, "FILL_FAILED");

// 5. 寫入後再驗一次網域：已被導走就清空並結束碼 6（值已進過頁面）
await new Promise((r) => setTimeout(r, SETTLE_MS));
const after = keyOf(page.url());
if (after !== want) {
	await page.evaluate(clear, selector).catch(() => {});
	await finish(EXIT.URL_MISMATCH_AFTER, "URL_MISMATCH");
}

// 6. 只比對長度，不讀回值本身
const gotLength = await page.evaluate((sel) => {
	const el = document.querySelector(sel);
	return el ? el.value.length : -1;
}, selector);
if (gotLength !== wantLength) {
	await page.evaluate(clear, selector).catch(() => {});
	await finish(EXIT.FILL_FAILED, "FILL_FAILED");
}

await finish(EXIT.FILLED, `FILLED ${field}`);
