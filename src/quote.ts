// 報價：Yahoo Finance chart 接口（免費、不用註冊；含盤前盤後）。
// parseChart 不碰網路，方便測試；fetchQuote 用 requestUrl（iPad 也能用，不受 CORS 限制）。
import { requestUrl } from "obsidian";

export type Session = "pre" | "regular" | "post" | "closed";

export interface ExtPrice {
	kind: "pre" | "post";
	price: number;
}

export interface Quote {
	price: number | null;
	prevClose: number | null;
	currency: string;
	name: string;
	session: Session;
	ext: ExtPrice | null; // 盤前／盤後最新價
	at: number; // 抓到的時間（ms）
}

export class QuoteError extends Error {
	constructor(
		message: string,
		public status?: number,
		public network = false, // 連不上（離線、逾時）；和「代號查不到」「回應格式不對」分開
	) {
		super(message);
	}
}

export const SESSION_LABEL: Record<Session, string> = { pre: "盤前", regular: "盤中", post: "盤後", closed: "收盤" };

export function chartUrl(ticker: string): string {
	return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`;
}

interface Period {
	start: number;
	end: number;
}

const valid = (p: Period | undefined): p is Period => !!p && typeof p.start === "number" && p.end > p.start;

/** 解析 Yahoo chart 回應。nowSec：現在的 Unix 秒數。 */
export function parseChart(json: unknown, nowSec: number = Date.now() / 1000, at: number = Date.now()): Quote {
	const res = (json as { chart?: { result?: unknown[]; error?: { description?: string } } })?.chart;
	const r = res?.result?.[0] as
		| {
				meta?: Record<string, unknown> & { currentTradingPeriod?: { pre?: Period; regular?: Period; post?: Period } };
				timestamp?: number[];
				indicators?: { quote?: { close?: (number | null)[] }[] };
		  }
		| undefined;
	if (!r?.meta) throw new QuoteError(res?.error?.description || "查無資料");
	const m = r.meta;
	const tp = m.currentTradingPeriod ?? {};
	let session: Session = "closed";
	if (valid(tp.pre) && nowSec >= tp.pre.start && nowSec < tp.pre.end) session = "pre";
	else if (valid(tp.regular) && nowSec >= tp.regular.start && nowSec < tp.regular.end) session = "regular";
	else if (valid(tp.post) && nowSec >= tp.post.start && nowSec < tp.post.end) session = "post";

	// 最後一根有價格的 1 分 K：落在盤後區間＝盤後價，落在盤前區間＝盤前價
	const ts = r.timestamp ?? [];
	const closes = r.indicators?.quote?.[0]?.close ?? [];
	let last: number | null = null;
	let lastT = 0;
	for (let i = closes.length - 1; i >= 0; i--) {
		const c = closes[i];
		if (typeof c === "number" && isFinite(c)) {
			last = c;
			lastT = ts[i] ?? 0;
			break;
		}
	}
	const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
	let ext: ExtPrice | null = null;
	if (last !== null && valid(tp.post) && lastT >= tp.post.start) ext = { kind: "post", price: last };
	else if (last !== null && valid(tp.pre) && lastT >= tp.pre.start && lastT < tp.pre.end) ext = { kind: "pre", price: last };
	else {
		// 備援：交易時段已經換成下一個交易日（半夜、週末），但 K 線還是上一個交易日的 →
		// 最後一根 K 比「最後一筆盤中成交」晚，就是延長時段的價格（隔 6 小時以上＝隔天盤前，否則＝盤後）
		const rmt = num(m.regularMarketTime);
		if (last !== null && session !== "regular" && rmt !== null && lastT > rmt + 90) ext = { kind: lastT - rmt > 6 * 3600 ? "pre" : "post", price: last };
	}

	return {
		price: num(m.regularMarketPrice),
		prevClose: num(m.chartPreviousClose) ?? num(m.previousClose),
		currency: typeof m.currency === "string" ? m.currency : "USD",
		name: String(m.shortName ?? m.longName ?? ""),
		session,
		ext,
		at,
	};
}

export async function fetchQuote(ticker: string): Promise<Quote> {
	let res;
	try {
		res = await requestUrl({ url: chartUrl(ticker), method: "GET", throw: false });
	} catch (e) {
		throw new QuoteError(`連不到 Yahoo（${String((e as Error)?.message ?? e).slice(0, 80)}）`, undefined, true);
	}
	if (res.status === 404) throw new QuoteError("找不到這個代號", 404);
	if (res.status === 429) throw new QuoteError("Yahoo 請求太頻繁，稍後再試", 429);
	if (res.status < 200 || res.status >= 300) throw new QuoteError(`Yahoo HTTP ${res.status}`, res.status);
	let json: unknown;
	try {
		json = res.json;
	} catch {
		throw new QuoteError("Yahoo 回應格式不對");
	}
	return parseChart(json);
}

/** 代號正規化：大寫、去空白；允許 A-Z、數字、. - ^ =（例如 BRK-B、2330.TW、^GSPC、TWD=X）。 */
export function normalizeTicker(s: string): string {
	return s.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidTicker(s: string): boolean {
	return /^[A-Z0-9.\-^=]{1,15}$/.test(s);
}

/** 美股代號（沒有交易所後綴）才有華爾街評級。 */
export function isUsTicker(t: string): boolean {
	return /^[A-Z][A-Z0-9-]{0,9}$/.test(t);
}
