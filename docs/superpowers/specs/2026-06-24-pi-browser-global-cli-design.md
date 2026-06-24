# pi-browser 全域 dispatcher 設計

- 日期：2026-06-24
- 狀態：已核可（介面決策由操作者於選擇題定案）
- 目標 repo：`/Users/tung/Codes/pi-browser-tools`（`browser-tools` pi skill 的 source of truth）

## 1. 問題

本 skill 的瀏覽器腳本（`browser-*.js`）在 SKILL.md 中以 `{baseDir}/browser-*.js`
形式被呼叫。`{baseDir}` 只會解析成「**當前**技能」的目錄，因此**其他技能無法引用**
這些腳本——跨技能引用（cross-skill reference）不成立。

需求：給本 skill 一個**穩定的全域入口**，讓任何 pi 技能都能呼叫，且不依賴 `{baseDir}`。

## 2. 既有慣例（範本）

此 setup 已有現成範本：`handless-termal` 技能透過全域 `ht` 指令被引用。

- `~/.local/bin/ht` 是 symlink → `/Users/tung/Codes/handless-termal/bin/ht`
- 真實 `bin/ht` 用 `Path(__file__).resolve()` 解析自身真實位置來找相依
- repo 留原地當 source of truth；`~/.local/bin`（在 PATH 上）放 symlink
- `handless-termal` 的 SKILL.md 直接寫 `ht <cmd>`，而非 `{baseDir}/...`

本設計**複製這套慣例**到 `pi-browser-tools`。

## 3. 決策（操作者定案）

| 項目 | 決策 | 備選（未採用） |
|---|---|---|
| 全域介面形態 | **單一 dispatcher** `pi-browser <cmd>` | 每支腳本一個前綴 symlink；不加前綴 symlink |
| 暴露範圍 | **全部 `browser-*.js`**（11 支） | 只暴露 4 支 standalone headless |
| dispatcher 實作 | **POSIX sh**（零相依、零額外 Node 啟動） | Node dispatcher |
| 安裝位置 | `~/.local/bin`（同 `ht`，可用 `PI_BROWSER_BIN_DIR` 覆寫） | npm global / `npm link` |

## 4. 架構

新增 3 個檔，更新 2 份文件，**完全不動現有 `browser-*.js`**（零風險）。

### 4.1 `bin/pi-browser`（dispatcher）
唯一職責：解析自身真實位置 → 映射子指令 → exec 真實腳本。

- 用可攜的「跟著 symlink 走」迴圈解析 `$0`（macOS `readlink` 無 `-f`），算出 repo
  root（`bin/..`）。
- **通用映射**：`pi-browser <x> [args]` → `exec node "<root>/browser-<x>.js" [args]`。
  通用規則 → 未來新增任何 `browser-*.js` 自動有全域入口，dispatcher 免改。
- 用**真實 repo 路徑** exec → Node 從 repo root 解析 `node_modules`（puppeteer）與相對
  `./zyte-proxy.js` import，全部正確（symlink 只在入口，目標走真實路徑）。
- `pi-browser` / `--help` / `help` → **動態**列出 repo 內所有 `browser-*.js` 子指令。
- **Preflight**：exec 前若 `node_modules/puppeteer` 不存在 → 印明確指引
  （`執行 <root>/install.sh`）並 `exit 1`，取代難懂的 `Cannot find package 'puppeteer'`。
- 未知子指令 → 印 help、`exit 2`。

### 4.2 `install.sh`（冪等安裝器）
唯一職責：相依 + symlink + PATH 檢查。

- 解析自身目錄（任何 CWD 可跑）。
- 若 `node_modules/puppeteer` 缺 → `cd <root> && npm install`。
- `mkdir -p <bin_dir>`；`ln -sf <root>/bin/pi-browser <bin_dir>/pi-browser`（冪等）。
  `bin_dir` 預設 `~/.local/bin`，可用 `PI_BROWSER_BIN_DIR` 覆寫。
- 檢查 `bin_dir` 是否在 PATH，不在則**警告**（不失敗）並印該加的 `export PATH` 行。
- 結尾印成功訊息 + 跨技能用法範例。

### 4.3 SKILL.md 更新
新增「Global CLI（cross-skill）」段：說明安裝後 `pi-browser <cmd>` 在 PATH，**其他技能
應引用 `pi-browser ...` 而非 `{baseDir}/...`**，並列 `pi-browser <cmd>` ↔ `browser-<cmd>.js`
的 1:1 對應。現有 `{baseDir}` 範例保留（本技能內仍可用）。

### 4.4 README.md 更新（輕量）
§3 Install & use 加一小段：全域 `pi-browser` 指令 + `install.sh`，與既有 `pi install` 並列。

## 5. 邊界與風險

- 現有 `browser-*.js` **零改動** → 對既有行為零風險；dispatcher 只「挑一支、用真實路徑 exec」。
- `google_search.mjs`（puppeteer-core、未文件化）**刻意不暴露**（不符 `browser-*.js` 規則）；
  要的話加一行 alias 即可。

## 6. 驗證（實作後實跑）

1. 安裝前（node_modules 仍缺）：`bin/pi-browser --help` 列出子指令；`bin/pi-browser bogus`
   → `exit 2`；`bin/pi-browser capture` → preflight「deps not installed」`exit 1`。
2. `./install.sh` → 建立 symlink、裝好 deps（冪等：重跑不報錯）。
3. **從 repo 外**（如 `/tmp`）：`pi-browser --help` 經 PATH symlink 列子指令；
   `pi-browser netlog <url>` 回傳 JSON → 證明跨目錄、經 symlink、node_modules 仍解析
   正確（即「跨技能引用」實際成立）。

## 7. 刻意不做（YAGNI）

- 不加 npm `bin` / `npm link`（symlink + repo-as-source 已對齊 `ht`）。
- 不做每支 symlink、不做 `--version`。
