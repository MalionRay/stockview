// 持股：每檔股票一篇筆記（預設在 Portfolio 資料夾），frontmatter 寫代號、股數、成本、估值上下限。
// 格式和之前的 Dataview 儀表板相同，舊筆記可以直接用。股數空白＝只追蹤（觀察名單）。
import { App, TFile, normalizePath } from "obsidian";
import { isValidTicker, normalizeTicker } from "./quote";

export interface Holding {
	ticker: string;
	shares: number | null; // null＝只追蹤，不算損益
	cost: number | null; // 每股平均成本
	low: number | null; // 估值下限／跌破警示
	high: number | null; // 估值上限／突破警示
	paths: string[]; // 來源筆記（同一檔分好幾篇時會有多篇）
}

export interface HoldingInput {
	ticker: string;
	shares: number | null;
	cost: number | null;
	low: number | null;
	high: number | null;
}

/** frontmatter 的數字：空白、null、不是數字都當作沒填。允許 "1,200"。 */
export function num(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
	return isFinite(n) ? n : null;
}

function inFolder(path: string, folder: string): boolean {
	const f = normalizePath(folder);
	return !f || path.startsWith(f + "/");
}

/** 讀資料夾裡所有股票筆記（含子資料夾）。 */
export function readHoldings(app: App, folder: string): Holding[] {
	const raw: (HoldingInput & { path: string })[] = [];
	for (const f of app.vault.getMarkdownFiles()) {
		if (!inFolder(f.path, folder)) continue;
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm || fm.ticker === undefined || fm.ticker === null || fm.ticker === "") continue;
		const ticker = normalizeTicker(String(fm.ticker));
		if (!isValidTicker(ticker)) continue;
		raw.push({ ticker, shares: num(fm.shares), cost: num(fm.cost), low: num(fm.low), high: num(fm.high), path: f.path });
	}
	return mergeHoldings(raw);
}

/** 同一檔股票寫在好幾篇筆記：股數相加、成本加權平均；上下限用第一篇有填的。 */
export function mergeHoldings(list: (HoldingInput & { path: string })[]): Holding[] {
	const by = new Map<string, Holding & { costSum: number; costShares: number }>();
	for (const x of [...list].sort((a, b) => (a.path < b.path ? -1 : 1))) {
		let h = by.get(x.ticker);
		if (!h) {
			h = { ticker: x.ticker, shares: null, cost: null, low: null, high: null, paths: [], costSum: 0, costShares: 0 };
			by.set(x.ticker, h);
		}
		h.paths.push(x.path);
		if (x.shares !== null) {
			h.shares = (h.shares ?? 0) + x.shares;
			if (x.cost !== null) {
				h.costSum += x.cost * x.shares;
				h.costShares += x.shares;
			}
		}
		if (h.low === null && x.low !== null) h.low = x.low;
		if (h.high === null && x.high !== null) h.high = x.high;
	}
	return [...by.values()].map(({ costSum, costShares, ...h }) => ({ ...h, cost: costShares ? costSum / costShares : null }));
}

const fmtNum = (v: number | null) => (v === null ? "" : String(v));

export function holdingNote(h: HoldingInput): string {
	return [
		"---",
		`ticker: ${h.ticker}`,
		`shares: ${fmtNum(h.shares)}`,
		`cost: ${fmtNum(h.cost)}`,
		`low: ${fmtNum(h.low)}`,
		`high: ${fmtNum(h.high)}`,
		"---",
		`# ${h.ticker}`,
		"",
		"## 買進理由",
		"- ",
		"",
		"## 估值想法",
		"- 下限 / 上限的依據：",
		"",
		"## 紀錄",
		"- ",
		"",
	].join("\n");
}

/** 檢查輸入；回傳錯誤訊息或 null。 */
export function checkInput(h: HoldingInput): string | null {
	if (!isValidTicker(h.ticker)) return "代號只能有英文字母、數字和 . - ^ =（例如 AAPL、BRK-B）";
	for (const [k, v] of [["股數", h.shares], ["成本", h.cost], ["下限", h.low], ["上限", h.high]] as const)
		if (v !== null && (!isFinite(v) || v < 0)) return `${k}要是 0 以上的數字`;
	if (h.low !== null && h.high !== null && h.low >= h.high) return "下限要比上限小";
	return null;
}

export async function addHolding(app: App, folder: string, h: HoldingInput): Promise<TFile> {
	const dir = normalizePath(folder || "Portfolio");
	if (!(await app.vault.adapter.exists(dir))) await app.vault.createFolder(dir);
	const path = normalizePath(`${dir}/${h.ticker.replace(/[\\/:*?"<>|]/g, "_")}.md`);
	if (app.vault.getAbstractFileByPath(path)) throw new Error(`已經有 ${h.ticker} 了，請用「編輯」修改`);
	return app.vault.create(path, holdingNote(h));
}

/** 改 frontmatter（股數、成本、上下限）；筆記內文不動。 */
export async function updateHolding(app: App, path: string, h: Omit<HoldingInput, "ticker">): Promise<void> {
	const f = app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) throw new Error("找不到這篇筆記");
	await app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
		fm.shares = h.shares ?? "";
		fm.cost = h.cost ?? "";
		fm.low = h.low ?? "";
		fm.high = h.high ?? "";
	});
}
