// 華爾街評級（僅供參考）：Finnhub 免費接口 /stock/recommendation（分析師買進／持有／賣出人數，每月更新）。
// 金鑰存在 SecretStorage（不寫進 data.json、不寫進筆記）；結果快取在這台裝置的 localStorage，12 小時更新一次。
import { App, requestUrl } from "obsidian";

export const SECRET_FINNHUB = "stockview-finnhub";
export const LS_RATINGS = "stockview:ratings";
export const RATING_TTL = 12 * 3600_000;

export interface Rating {
	period: string; // 例如 2026-11-01
	strongBuy: number;
	buy: number;
	hold: number;
	sell: number;
	strongSell: number;
	at: number; // 抓到的時間
}

export interface RatingInfo {
	label: string;
	cls: "sb" | "b" | "h" | "s" | "ss";
	score: number; // 1＝強力買進 … 5＝強力賣出
	total: number;
}

export class RatingError extends Error {
	constructor(
		message: string,
		public kind: "auth" | "limit" | "other",
	) {
		super(message);
	}
}

/** 取最新一期（period 最大）的分析師人數。 */
export function parseRecommendation(json: unknown, at = Date.now()): Rating | null {
	if (!Array.isArray(json) || !json.length) return null;
	const n = (v: unknown) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : 0);
	let best: Record<string, unknown> | null = null;
	for (const x of json as Record<string, unknown>[]) if (x && (!best || String(x.period) > String(best.period))) best = x;
	if (!best) return null;
	return { period: String(best.period ?? ""), strongBuy: n(best.strongBuy), buy: n(best.buy), hold: n(best.hold), sell: n(best.sell), strongSell: n(best.strongSell), at };
}

export function ratingInfo(r: Rating | null | undefined): RatingInfo | null {
	if (!r) return null;
	const total = r.strongBuy + r.buy + r.hold + r.sell + r.strongSell;
	if (!total) return null;
	const score = (r.strongBuy * 1 + r.buy * 2 + r.hold * 3 + r.sell * 4 + r.strongSell * 5) / total;
	const [label, cls] =
		score <= 1.5 ? (["強力買進", "sb"] as const) : score <= 2.5 ? (["買進", "b"] as const) : score <= 3.5 ? (["持有", "h"] as const) : score <= 4.5 ? (["賣出", "s"] as const) : (["強力賣出", "ss"] as const);
	return { label, cls, score: Math.round(score * 100) / 100, total };
}

export function cleanKey(s: string): string {
	return s.replace(/[^A-Za-z0-9]/g, "");
}

export async function fetchRating(ticker: string, key: string): Promise<Rating | null> {
	const url = `https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${encodeURIComponent(key)}`;
	let res;
	try {
		res = await requestUrl({ url, method: "GET", throw: false });
	} catch (e) {
		throw new RatingError(`連不到 Finnhub（${String((e as Error)?.message ?? e).slice(0, 80)}）`, "other");
	}
	if (res.status === 401 || res.status === 403) throw new RatingError("Finnhub 金鑰不對或沒有權限", "auth");
	if (res.status === 429) throw new RatingError("Finnhub 每分鐘次數用完，稍後再試", "limit");
	if (res.status < 200 || res.status >= 300) throw new RatingError(`Finnhub HTTP ${res.status}`, "other");
	return parseRecommendation(res.json);
}

type Cache = Record<string, Rating | { none: true; at: number }>;

/** 評級快取＋依序抓取（免費版每分鐘 60 次，這裡每次間隔 1.1 秒）。 */
export class Ratings {
	private cache: Cache;
	private running = false;
	authFailedAt = 0;
	retryAt = 0; // 次數用完或連不上：這個時間之前先不再試（不然每一輪報價更新都會再打一次）
	lastError = "";

	constructor(
		private app: App,
		private onChange: () => void,
	) {
		this.cache = (app.loadLocalStorage(LS_RATINGS) as Cache | null) ?? {};
	}

	key(): string {
		return this.app.secretStorage?.getSecret(SECRET_FINNHUB) ?? "";
	}

	get(ticker: string): Rating | null {
		const c = this.cache[ticker];
		return c && !("none" in c) ? c : null;
	}

	/** 有查過但 Finnhub 沒有這檔的資料。 */
	none(ticker: string): boolean {
		const c = this.cache[ticker];
		return !!c && "none" in c;
	}

	stale(ticker: string, now = Date.now()): boolean {
		const c = this.cache[ticker];
		return !c || now - c.at > RATING_TTL;
	}

	clear(): void {
		this.cache = {};
		this.authFailedAt = 0;
		this.retryAt = 0;
		this.lastError = "";
		this.app.saveLocalStorage(LS_RATINGS, this.cache);
	}

	/** 背景補齊過期的評級；金鑰錯誤後 1 小時內不再試，次數用完或連不上先停 1 分鐘。 */
	async refresh(tickers: string[], sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms)), now: () => number = Date.now): Promise<void> {
		const key = this.key();
		if (!key || this.running || (this.authFailedAt && now() - this.authFailedAt < 3600_000) || now() < this.retryAt) return;
		const todo = tickers.filter((t) => this.stale(t, now()));
		if (!todo.length) return;
		this.running = true;
		try {
			for (let i = 0; i < todo.length; i++) {
				if (i) await sleep(1100);
				const t = todo[i];
				try {
					const r = await fetchRating(t, key);
					this.cache[t] = r ? { ...r, at: now() } : { none: true, at: now() };
					this.lastError = "";
				} catch (e) {
					const err = e as RatingError;
					this.lastError = err.message ?? String(e);
					if (err.kind === "auth") this.authFailedAt = now();
					else this.retryAt = now() + 60_000;
					break;
				}
				this.app.saveLocalStorage(LS_RATINGS, this.cache);
				this.onChange();
			}
		} finally {
			this.running = false;
		}
	}
}
