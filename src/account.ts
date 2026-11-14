// 帳戶：投資金額與現金（v0.7.0）。整個帳戶只有一組，清單只用來分類（使用者 2026-11-14 選的）。
// 存在股票資料夾裡的「帳戶.md」（frontmatter invested、cash、currency），跟著 Vault 同步；
// 不放外掛設定（data.json 在 .obsidian 裡，使用者的 Remotely Save 不同步 .obsidian，iPad 填的電腦會看不到）。
import { App, TFile, normalizePath } from "obsidian";
import { Base, toBase } from "./calc";
import { folderRoot, num } from "./holdings";

export const ACCOUNT_FILE = "帳戶.md";

export interface Account {
	invested: number | null; // 投資金額：總共投入的本金（加碼或提款時改）
	cash: number | null; // 現金：照券商的數字填；null＝用「投資金額 − 持股成本」估算
	currency: Base; // 投資金額和現金用的幣別
	exists: boolean; // 有沒有「帳戶.md」
}

export type AccountInput = Omit<Account, "exists">;

export const NO_ACCOUNT: Account = { invested: null, cash: null, currency: "USD", exists: false };

export function accountPath(folder: string): string {
	return normalizePath(`${folderRoot(folder)}/${ACCOUNT_FILE}`);
}

/** 有填投資金額或現金才顯示總資產、總盈虧。 */
export function hasAccount(a: Account | null | undefined): boolean {
	return !!a && (a.invested !== null || a.cash !== null);
}

/** 讀「帳戶.md」；沒有這篇就是沒設定。幣別沒寫用總計幣別。 */
export function readAccount(app: App, folder: string, fallback: Base): Account {
	const f = app.vault.getAbstractFileByPath(accountPath(folder));
	if (!(f instanceof TFile)) return { ...NO_ACCOUNT, currency: fallback };
	const fm = (app.metadataCache.getFileCache(f)?.frontmatter ?? {}) as Record<string, unknown>;
	const cur = String(fm.currency ?? "")
		.trim()
		.toUpperCase();
	return { invested: num(fm.invested), cash: num(fm.cash), currency: cur === "TWD" ? "TWD" : cur === "USD" ? "USD" : fallback, exists: true };
}

/** 檢查輸入；回傳錯誤訊息或 null。現金可以是負的（融資）。 */
export function checkAccount(a: AccountInput): string | null {
	if (a.invested !== null && (!isFinite(a.invested) || a.invested < 0)) return "投資金額要是 0 以上的數字";
	if (a.cash !== null && !isFinite(a.cash)) return "現金要是數字";
	return null;
}

const fmtNum = (v: number | null) => (v === null ? "" : String(v));

export function accountNote(a: AccountInput): string {
	return [
		"---",
		`invested: ${fmtNum(a.invested)}`,
		`cash: ${fmtNum(a.cash)}`,
		`currency: ${a.currency}`,
		"---",
		"# 帳戶",
		"",
		"StockView 用這篇算總資產和總盈虧（也可以在儀表板點「現金」或「總盈虧」卡片修改）：",
		"- invested：投資金額，總共投入的本金；加碼或提款時改",
		"- cash：現金，券商帳戶裡還沒買股票的錢，照券商 App 的數字填；空白＝用「投資金額 − 持股成本」估算（算不到已經賣掉的盈虧和股息）",
		"- currency：USD（美元）或 TWD（台幣）",
		"",
		"總資產＝股票市值＋現金；總盈虧＝總資產 − 投資金額。",
		"",
	].join("\n");
}

/** 存「帳戶.md」：已經有就只改 frontmatter（內文不動），沒有就建立。 */
export async function saveAccount(app: App, folder: string, a: AccountInput): Promise<void> {
	const path = accountPath(folder);
	const f = app.vault.getAbstractFileByPath(path);
	if (f instanceof TFile) {
		await app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
			fm.invested = a.invested ?? "";
			fm.cash = a.cash ?? "";
			fm.currency = a.currency;
		});
		return;
	}
	const root = folderRoot(folder);
	if (!(await app.vault.adapter.exists(root))) await app.vault.createFolder(root);
	await app.vault.create(path, accountNote(a));
}

export interface AccountSummary {
	invested: number | null; // 都換算成總計幣別
	cash: number;
	cashEstimated: boolean; // 現金沒填，用「投資金額 − 持股成本」估算
	assets: number; // 總資產＝市值＋現金
	pl: number | null; // 總盈虧＝總資產 − 投資金額（沒填投資金額就算不出來）
	plPct: number | null;
	needsFx: boolean; // 帳戶幣別和總計幣別不同
}

/**
 * 總資產、總盈虧。value＝所有持股的市值、cost＝所有有填成本的持股成本（都已換成總計幣別）。
 * 沒填投資金額也沒填現金就回傳 null（畫面維持原本的卡片）。
 */
export function accountSummary(a: Account | null | undefined, t: { value: number; cost: number }, base: Base, fx: number | null): AccountSummary | null {
	if (!a || !hasAccount(a)) return null;
	const conv = (v: number | null) => (v === null ? null : toBase(v, a.currency, base, fx));
	const invested = conv(a.invested);
	const given = conv(a.cash);
	const cashEstimated = given === null;
	const cash = given ?? invested! - t.cost;
	const assets = t.value + cash;
	const pl = invested === null ? null : assets - invested;
	const plPct = pl !== null && invested !== null && invested > 0 ? (pl / invested) * 100 : null;
	return { invested, cash, cashEstimated, assets, pl, plPct, needsFx: a.currency !== base };
}

/** 佔比（%）；分母不是正數就算不出來。 */
export function share(part: number | null, whole: number | null): number | null {
	if (part === null || whole === null || !(whole > 0)) return null;
	return (part / whole) * 100;
}
