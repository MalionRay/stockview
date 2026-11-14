// 持股與清單：每檔股票一篇筆記，frontmatter 寫代號、股數、成本、估值上下限。
// 清單＝股票資料夾（預設 Portfolio）底下的子資料夾；直接放在資料夾裡的筆記是「主清單」（和之前 Dataview 儀表板的格式相同）。
// 同一檔可以在好幾個清單，各有自己的股數、成本、上下限（例如不同券商帳戶、持股和觀察名單）。股數空白＝只追蹤。
import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { isValidTicker, normalizeTicker } from "./quote";

export const MAIN_LIST = ""; // 主清單（資料夾本身）
export const MAIN_LIST_NAME = "主清單";
export const ALL_LISTS = "*"; // 畫面上的「全部」

export interface Holding {
	ticker: string;
	list: string; // 所在清單（"" 是主清單）；「全部」裡合併的是第一個清單
	lists: string[]; // 出現在哪些清單（「全部」用）
	shares: number | null; // null＝只追蹤，不算損益
	cost: number | null; // 每股平均成本
	low: number | null; // 估值下限／跌破警示
	high: number | null; // 估值上限／突破警示
	fair: number | null; // 合理價位（只顯示，不警示）
	paths: string[]; // 來源筆記（同一檔在同一清單分好幾篇、或「全部」合併時會有多篇）
}

export interface HoldingInput {
	ticker: string;
	shares: number | null;
	cost: number | null;
	low: number | null;
	high: number | null;
	fair?: number | null;
}

export type RawHolding = HoldingInput & { path: string; list: string };

export function listLabel(list: string): string {
	return list === MAIN_LIST ? MAIN_LIST_NAME : list;
}

/** frontmatter 的數字：空白、null、不是數字都當作沒填。允許 "1,200"。 */
export function num(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
	return isFinite(n) ? n : null;
}

function root(folder: string): string {
	return normalizePath(folder || "Portfolio");
}

/** 股票資料夾（主清單）的路徑。 */
export const folderRoot = root;

/** 筆記屬於哪個清單；不在股票資料夾裡回傳 null。更深的子資料夾算在第一層的清單裡。 */
export function listOf(path: string, folder: string): string | null {
	const r = root(folder);
	if (!path.startsWith(r + "/")) return null;
	const rest = path.slice(r.length + 1).split("/");
	return rest.length > 1 ? rest[0] : MAIN_LIST;
}

/** 讀所有清單的股票筆記；同一清單裡同一檔的多篇先合併。 */
export function readHoldings(app: App, folder: string): Holding[] {
	const raw: RawHolding[] = [];
	for (const f of app.vault.getMarkdownFiles()) {
		const list = listOf(f.path, folder);
		if (list === null) continue;
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm || fm.ticker === undefined || fm.ticker === null || fm.ticker === "") continue;
		const ticker = normalizeTicker(String(fm.ticker));
		if (!isValidTicker(ticker)) continue;
		raw.push({ ticker, shares: num(fm.shares), cost: num(fm.cost), low: num(fm.low), high: num(fm.high), fair: num(fm.fair), path: f.path, list });
	}
	return mergeHoldings(raw);
}

type Acc = Holding & { costSum: number; costShares: number };

/** 合併：股數相加、成本加權平均；上下限用第一篇有填的。byList＝只合併同一清單裡的（預設），否則跨清單合併（「全部」）。 */
function merge(list: (RawHolding | Holding)[], byList: boolean): Holding[] {
	const by = new Map<string, Acc>();
	const pathOf = (x: RawHolding | Holding) => ("path" in x ? x.path : x.paths[0] ?? "");
	const sorted = [...list].sort((a, b) => (a.list !== b.list ? (a.list < b.list ? -1 : 1) : pathOf(a) < pathOf(b) ? -1 : 1));
	for (const x of sorted) {
		const key = byList ? `${x.list}|${x.ticker}` : x.ticker;
		let h = by.get(key);
		if (!h) {
			h = { ticker: x.ticker, list: x.list, lists: [], shares: null, cost: null, low: null, high: null, fair: null, paths: [], costSum: 0, costShares: 0 };
			by.set(key, h);
		}
		h.paths.push(...("path" in x ? [x.path] : x.paths));
		if (!h.lists.includes(x.list)) h.lists.push(x.list);
		if (x.shares !== null) {
			h.shares = (h.shares ?? 0) + x.shares;
			if (x.cost !== null) {
				h.costSum += x.cost * x.shares;
				h.costShares += x.shares;
			}
		}
		if (h.low === null && x.low !== null) h.low = x.low;
		if (h.high === null && x.high !== null) h.high = x.high;
		if (h.fair === null && (x.fair ?? null) !== null) h.fair = x.fair ?? null;
	}
	return [...by.values()].map(({ costSum, costShares, ...h }) => ({ ...h, cost: costShares ? costSum / costShares : null }));
}

export function mergeHoldings(list: RawHolding[]): Holding[] {
	return merge(list, true);
}

/** 「全部」：跨清單同一檔合併成一列。 */
export function mergeAcrossLists(hs: Holding[]): Holding[] {
	return merge(hs, false);
}

/** 所有清單名稱：子資料夾（含空的）＋有股票的清單；主清單排第一，其他依名稱。 */
export function readLists(app: App, folder: string, holdings: Holding[]): string[] {
	const r = root(folder);
	const set = new Set<string>(holdings.map((h) => h.list));
	const f = app.vault.getAbstractFileByPath(r);
	if (f instanceof TFolder) for (const c of f.children) if (c instanceof TFolder) set.add(c.name);
	set.add(MAIN_LIST);
	return [...set].sort((a, b) => (a === MAIN_LIST ? -1 : b === MAIN_LIST ? 1 : a.localeCompare(b, "zh-Hant")));
}

/** 畫面上要顯示的清單：主清單沒有股票、又有其他清單時不顯示。 */
export function visibleLists(lists: string[], holdings: Holding[]): string[] {
	const others = lists.filter((l) => l !== MAIN_LIST);
	const mainUsed = holdings.some((h) => h.list === MAIN_LIST);
	return mainUsed || !others.length ? lists : others;
}

const fmtNum = (v: number | null) => (v === null ? "" : String(v));

export function holdingNote(h: HoldingInput): string {
	return [
		"---",
		`ticker: ${h.ticker}`,
		`shares: ${fmtNum(h.shares)}`,
		`cost: ${fmtNum(h.cost)}`,
		`low: ${fmtNum(h.low)}`,
		`fair: ${fmtNum(h.fair ?? null)}`,
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
	const fair = h.fair ?? null;
	for (const [k, v] of [["股數", h.shares], ["成本", h.cost], ["下限", h.low], ["合理價位", fair], ["上限", h.high]] as const)
		if (v !== null && (!isFinite(v) || v < 0)) return `${k}要是 0 以上的數字`;
	if (h.low !== null && h.high !== null && h.low >= h.high) return "下限要比上限小";
	if (fair !== null && ((h.low !== null && fair < h.low) || (h.high !== null && fair > h.high))) return "合理價位要在下限和上限之間";
	return null;
}

/** 清單名稱檢查（也是資料夾名稱）。 */
export function checkListName(name: string, existing: string[]): string | null {
	const n = name.trim();
	if (!n) return "請輸入清單名稱";
	if (n.length > 30) return "名稱最多 30 個字";
	if (/[\\/:*?"<>|#^[\]]/.test(n) || n.startsWith(".") || n.endsWith(".")) return "名稱不能有 \\ / : * ? \" < > | # ^ [ ]，也不能用 . 開頭或結尾";
	// Windows 不能當資料夾名稱的保留字（同步到電腦會出問題）
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n)) return `「${n}」不能當資料夾名稱，請換一個`;
	if (n === MAIN_LIST_NAME || n === "全部" || n === ALL_LISTS) return `「${n}」是保留的名稱`;
	if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) return "已經有這個清單了";
	return null;
}

function listDir(folder: string, list: string): string {
	return list === MAIN_LIST ? root(folder) : normalizePath(`${root(folder)}/${list}`);
}

async function ensureFolder(app: App, dir: string): Promise<void> {
	if (!(await app.vault.adapter.exists(dir))) await app.vault.createFolder(dir);
}

export async function createList(app: App, folder: string, name: string): Promise<void> {
	await ensureFolder(app, root(folder));
	await ensureFolder(app, listDir(folder, name.trim()));
}

export async function renameList(app: App, folder: string, from: string, to: string): Promise<void> {
	const f = app.vault.getAbstractFileByPath(listDir(folder, from));
	if (!(f instanceof TFolder)) throw new Error("找不到這個清單的資料夾");
	await app.fileManager.renameFile(f, listDir(folder, to.trim()));
}

/** 刪除清單：整個資料夾照 Obsidian 的刪除設定移到垃圾桶。 */
export async function deleteList(app: App, folder: string, list: string): Promise<void> {
	if (list === MAIN_LIST) throw new Error("主清單不能刪除");
	const f: TAbstractFile | null = app.vault.getAbstractFileByPath(listDir(folder, list));
	if (!f) throw new Error("找不到這個清單的資料夾");
	await app.fileManager.trashFile(f);
}

export async function addHolding(app: App, folder: string, list: string, h: HoldingInput): Promise<TFile> {
	const dir = listDir(folder, list);
	await ensureFolder(app, root(folder));
	await ensureFolder(app, dir);
	const path = normalizePath(`${dir}/${h.ticker.replace(/[\\/:*?"<>|]/g, "_")}.md`);
	if (app.vault.getAbstractFileByPath(path)) throw new Error(`「${listLabel(list)}」已經有 ${h.ticker} 了，請用「編輯」修改`);
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
		fm.fair = h.fair ?? "";
		fm.high = h.high ?? "";
	});
}

/** 把一檔從這個清單移到另一個清單（搬筆記；目的地已經有就不搬）。 */
export async function moveHolding(app: App, folder: string, path: string, ticker: string, to: string): Promise<void> {
	const f = app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) throw new Error("找不到這篇筆記");
	const dir = listDir(folder, to);
	await ensureFolder(app, root(folder));
	await ensureFolder(app, dir);
	const dest = normalizePath(`${dir}/${f.name}`);
	if (app.vault.getAbstractFileByPath(dest)) throw new Error(`「${listLabel(to)}」已經有 ${ticker} 了`);
	await app.fileManager.renameFile(f, dest);
}
