// 各市場行情：主要指數與匯率的走勢（Yahoo chart API，免費、不用金鑰）。
// parseSeries／combineSeries 不碰網路，方便測試；fetchSeries 用 requestUrl。
import { requestUrl } from "obsidian";
import { Session } from "./quote";

export interface MarketItem {
	symbol: string;
	name: string;
	scale?: number; // 匯率：1 單位外幣用幾個（日圓 100、韓元 1000）
	unit?: string; // 匯率顯示用，例如「100 日圓」
	/** 這個代號拿不到時，用美元匯率換算：值＝mul 相乘 ÷ div 相乘 */
	fallback?: { mul: string[]; div: string[] };
}

export interface Market {
	id: string;
	label: string;
	items: MarketItem[];
	fx?: boolean;
}

export const MARKETS: Market[] = [
	{
		id: "us",
		label: "美股",
		items: [
			{ symbol: "^GSPC", name: "S&P 500" },
			{ symbol: "^DJI", name: "道瓊工業" },
			{ symbol: "^IXIC", name: "那斯達克綜合" },
			{ symbol: "^SOX", name: "費城半導體" },
		],
	},
	{
		id: "tw",
		label: "台股",
		items: [
			{ symbol: "^TWII", name: "加權指數" },
			{ symbol: "^TWOII", name: "櫃買指數" },
		],
	},
	{
		id: "jp",
		label: "日股",
		items: [
			{ symbol: "^N225", name: "日經 225" },
			{ symbol: "1306.T", name: "TOPIX（ETF 1306）" },
		],
	},
	{
		id: "cn",
		label: "陸股",
		items: [
			{ symbol: "000001.SS", name: "上證綜合" },
			{ symbol: "399001.SZ", name: "深證成指" },
			{ symbol: "000300.SS", name: "滬深 300" },
		],
	},
	{
		id: "kr",
		label: "韓股",
		items: [
			{ symbol: "^KS11", name: "KOSPI" },
			{ symbol: "^KQ11", name: "KOSDAQ" },
		],
	},
	{
		id: "eu",
		label: "歐股",
		items: [
			{ symbol: "^STOXX50E", name: "歐洲斯托克 50" },
			{ symbol: "^GDAXI", name: "德國 DAX" },
			{ symbol: "^FTSE", name: "英國富時 100" },
			{ symbol: "^FCHI", name: "法國 CAC 40" },
		],
	},
	{
		id: "fx",
		label: "匯率",
		fx: true,
		items: [
			{ symbol: "TWD=X", name: "美元／台幣", unit: "1 美元" },
			{ symbol: "JPYTWD=X", name: "日圓／台幣", unit: "100 日圓", scale: 100, fallback: { mul: ["TWD=X"], div: ["JPY=X"] } },
			{ symbol: "CNYTWD=X", name: "人民幣／台幣", unit: "1 人民幣", fallback: { mul: ["TWD=X"], div: ["CNY=X"] } },
			{ symbol: "KRWTWD=X", name: "韓元／台幣", unit: "1000 韓元", scale: 1000, fallback: { mul: ["TWD=X"], div: ["KRW=X"] } },
			{ symbol: "EURTWD=X", name: "歐元／台幣", unit: "1 歐元", fallback: { mul: ["EURUSD=X", "TWD=X"], div: [] } },
		],
	},
];

export interface RangeDef {
	id: string;
	label: string;
	range: string;
	interval: string;
	ttl: number; // 快取多久（ms）
	intraday: boolean;
}

export const RANGES: RangeDef[] = [
	{ id: "1d", label: "1日", range: "1d", interval: "5m", ttl: 60_000, intraday: true },
	{ id: "5d", label: "5日", range: "5d", interval: "15m", ttl: 5 * 60_000, intraday: true },
	{ id: "1mo", label: "1月", range: "1mo", interval: "60m", ttl: 15 * 60_000, intraday: true },
	{ id: "6mo", label: "6月", range: "6mo", interval: "1d", ttl: 30 * 60_000, intraday: false },
	{ id: "ytd", label: "今年", range: "ytd", interval: "1d", ttl: 30 * 60_000, intraday: false },
	{ id: "1y", label: "1年", range: "1y", interval: "1d", ttl: 30 * 60_000, intraday: false },
	{ id: "5y", label: "5年", range: "5y", interval: "1wk", ttl: 60 * 60_000, intraday: false },
];

export function rangeOf(id: string): RangeDef {
	return RANGES.find((r) => r.id === id) ?? RANGES[0];
}

export interface Point {
	t: number; // Unix 秒
	v: number;
}

export interface Series {
	symbol: string;
	points: Point[];
	base: number | null; // 比較基準：1日＝昨收，其他＝區間開始前的收盤（沒有就用第一點）
	last: number | null;
	gmtoffset: number; // 交易所時區與 UTC 的差（秒）
	session: Session;
	domain: [number, number] | null; // 1日：x 軸用整個交易時段（還沒收盤時線只畫到一半）
}

interface Period {
	start: number;
	end: number;
}
const valid = (p: Period | undefined): p is Period => !!p && typeof p.start === "number" && p.end > p.start;
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);

export class MarketError extends Error {
	constructor(
		message: string,
		public status?: number,
	) {
		super(message);
	}
}

export function chartUrl(symbol: string, r: RangeDef): string {
	return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${r.range}&interval=${r.interval}`;
}

export function parseSeries(json: unknown, r: RangeDef, nowSec = Date.now() / 1000): Series {
	const res = (json as { chart?: { result?: unknown[]; error?: { description?: string } } })?.chart;
	const x = res?.result?.[0] as
		| {
				meta?: Record<string, unknown> & { currentTradingPeriod?: { pre?: Period; regular?: Period; post?: Period } };
				timestamp?: number[];
				indicators?: { quote?: { close?: (number | null)[] }[] };
		  }
		| undefined;
	if (!x?.meta) throw new MarketError(res?.error?.description || "查無資料");
	const m = x.meta;
	const ts = x.timestamp ?? [];
	const cl = x.indicators?.quote?.[0]?.close ?? [];
	const points: Point[] = [];
	for (let i = 0; i < ts.length; i++) {
		const v = cl[i];
		if (typeof v === "number" && isFinite(v) && typeof ts[i] === "number") points.push({ t: ts[i], v });
	}
	if (!points.length) throw new MarketError("這段時間沒有資料");
	const tp = m.currentTradingPeriod ?? {};
	let session: Session = "closed";
	if (valid(tp.pre) && nowSec >= tp.pre.start && nowSec < tp.pre.end) session = "pre";
	else if (valid(tp.regular) && nowSec >= tp.regular.start && nowSec < tp.regular.end) session = "regular";
	else if (valid(tp.post) && nowSec >= tp.post.start && nowSec < tp.post.end) session = "post";
	const first = points[0].t;
	const lastT = points[points.length - 1].t;
	let domain: [number, number] | null = null;
	if (r.id === "1d" && valid(tp.regular) && first >= tp.regular.start - 3600 && lastT <= tp.regular.end + 3600)
		domain = [Math.min(first, tp.regular.start), Math.max(lastT, tp.regular.end)];
	return {
		symbol: String(m.symbol ?? ""),
		points,
		base: num(m.chartPreviousClose) ?? num(m.previousClose) ?? points[0].v,
		last: num(m.regularMarketPrice) ?? points[points.length - 1].v,
		gmtoffset: num(m.gmtoffset) ?? 0,
		session,
		domain,
	};
}

/** 用美元匯率換算交叉匯率：每個時間點取各序列「當時或之前最近」的值。 */
export function combineSeries(symbol: string, mul: Series[], div: Series[]): Series {
	const all = [...mul, ...div];
	if (!all.length) throw new MarketError("沒有可換算的匯率");
	const at = (s: Series, t: number): number | null => {
		let v: number | null = null;
		for (const p of s.points) {
			if (p.t > t) break;
			v = p.v;
		}
		return v ?? s.points[0]?.v ?? null;
	};
	const calc = (vals: (number | null)[], nMul: number): number | null => {
		if (vals.some((v) => v === null || v === 0)) return null;
		let r = 1;
		vals.forEach((v, i) => (r = i < nMul ? r * (v as number) : r / (v as number)));
		return r;
	};
	const lead = all[0];
	const points: Point[] = [];
	for (const p of lead.points) {
		const v = calc(all.map((s) => at(s, p.t)), mul.length);
		if (v !== null) points.push({ t: p.t, v });
	}
	if (!points.length) throw new MarketError("沒有可換算的匯率");
	return {
		symbol,
		points,
		base: calc(all.map((s) => s.base), mul.length),
		last: calc(all.map((s) => s.last), mul.length) ?? points[points.length - 1].v,
		gmtoffset: lead.gmtoffset,
		session: lead.session,
		domain: lead.domain,
	};
}

/** 乘上顯示倍數（例如 100 日圓）。 */
export function scaleSeries(s: Series, k: number): Series {
	if (k === 1) return s;
	const f = (v: number | null) => (v === null ? null : v * k);
	return { ...s, points: s.points.map((p) => ({ t: p.t, v: p.v * k })), base: f(s.base), last: f(s.last) };
}

export async function fetchChart(symbol: string, r: RangeDef): Promise<Series> {
	let res;
	try {
		res = await requestUrl({ url: chartUrl(symbol, r), method: "GET", throw: false });
	} catch (e) {
		throw new MarketError(`連不到 Yahoo（${String((e as Error)?.message ?? e).slice(0, 80)}）`);
	}
	if (res.status === 404) throw new MarketError("Yahoo 沒有這個代號", 404);
	if (res.status === 429) throw new MarketError("Yahoo 請求太頻繁，稍後再試", 429);
	if (res.status < 200 || res.status >= 300) throw new MarketError(`Yahoo HTTP ${res.status}`, res.status);
	let json: unknown;
	try {
		json = res.json;
	} catch {
		throw new MarketError("Yahoo 回應格式不對");
	}
	return parseSeries(json, r);
}

/** 抓一個項目的走勢（含交叉匯率的備援與快取）。 */
export class MarketData {
	private cache = new Map<string, { at: number; s: Series }>();

	constructor(private fetcher: (symbol: string, r: RangeDef) => Promise<Series> = fetchChart) {}

	clear(): void {
		this.cache.clear();
	}

	cached(item: MarketItem, r: RangeDef): Series | null {
		const s = this.cache.get(`${item.symbol}|${r.id}`)?.s;
		return s ? scaleSeries(s, item.scale ?? 1) : null;
	}

	private async raw(symbol: string, r: RangeDef, now: number): Promise<Series> {
		const key = `${symbol}|${r.id}`;
		const c = this.cache.get(key);
		if (c && now - c.at < r.ttl) return c.s;
		const s = await this.fetcher(symbol, r);
		this.cache.set(key, { at: now, s });
		return s;
	}

	async get(item: MarketItem, r: RangeDef, now = Date.now()): Promise<Series> {
		let s: Series;
		try {
			s = await this.raw(item.symbol, r, now);
		} catch (e) {
			const fb = item.fallback;
			if (!fb || (e as MarketError).status === 429) throw e;
			const mul = await Promise.all(fb.mul.map((x) => this.raw(x, r, now)));
			const div = await Promise.all(fb.div.map((x) => this.raw(x, r, now)));
			s = combineSeries(item.symbol, mul, div);
			this.cache.set(`${item.symbol}|${r.id}`, { at: now, s });
		}
		return scaleSeries(s, item.scale ?? 1);
	}
}

/** 交易所當地時間的文字。 */
export function timeLabel(t: number, gmtoffset: number, r: RangeDef, withDate = false): string {
	const d = new Date((t + gmtoffset) * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
	const hm = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
	if (r.id === "1d") return withDate ? `${md} ${hm}` : hm;
	if (r.intraday) return `${md} ${hm}`;
	if (r.id === "5y") return withDate ? `${d.getUTCFullYear()}/${md}` : `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`;
	return withDate ? `${d.getUTCFullYear()}/${md}` : md;
}

export function fmtLevel(v: number | null, fx = false): string {
	if (v === null || !isFinite(v)) return "—";
	const d = fx ? (Math.abs(v) < 10 ? 4 : 3) : 2;
	return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
