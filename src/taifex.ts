// 台指期（日盤／夜盤）：期交所行情網頁（mis.taifex.com.tw）用的公開資料，免費、不用金鑰。
// 這不是正式 API，格式可能改變或暫時擋掉；拿不到時卡片顯示原因，其他照常。不加任何偽裝的標頭。
// 期交所只給「現在」的報價，沒有歷史走勢；圖是這台裝置在市場頁開著時收到的價格（存在 localStorage，同一盤內保留）。
import type { App } from "obsidian";
import { requestUrl } from "obsidian";
import type { Point } from "./markets";

export const TAIFEX_URL = "https://mis.taifex.com.tw/futures/api/getQuoteList";
export const LS_TXF_POINTS = "stockview:txf-points";
const TPE = 8 * 3600; // 台北 UTC+8，沒有日光節約
const MAX_POINTS = 1500;

export type TxfSession = "day" | "night" | "closed";

export interface TxfQuote {
	name: string;
	last: number | null;
	ref: number | null; // 參考價（前一盤結算）
	high: number | null;
	low: number | null;
	time: string; // 期交所給的成交時間，例如 23:59:58
	market: "0" | "1"; // 0＝日盤，1＝夜盤
}

export class TaifexError extends Error {
	constructor(
		message: string,
		public status?: number,
	) {
		super(message);
	}
}

/** 台北時間的星期（0＝日）與從午夜起算的分鐘。 */
function tpe(nowSec: number): { wd: number; min: number } {
	const d = new Date((nowSec + TPE) * 1000);
	return { wd: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** 現在哪一盤在交易：日盤 08:45～13:45（週一～五），夜盤 15:00～隔天 05:00（週一～五下午開始）。國定假日不知道，查到沒成交就當收盤。 */
export function txfSession(nowSec = Date.now() / 1000): TxfSession {
	const { wd, min } = tpe(nowSec);
	const weekday = wd >= 1 && wd <= 5;
	if (weekday && min >= 8 * 60 + 45 && min < 13 * 60 + 45) return "day";
	if (weekday && min >= 15 * 60) return "night";
	if (wd >= 2 && wd <= 6 && min < 5 * 60) return "night";
	return "closed";
}

/** 要查哪一盤：平日 08:45～15:00 查日盤，其他時間查夜盤（收盤時顯示最後一盤）。 */
export function txfMarket(nowSec = Date.now() / 1000): "0" | "1" {
	const { wd, min } = tpe(nowSec);
	return wd >= 1 && wd <= 5 && min >= 8 * 60 + 45 && min < 15 * 60 ? "0" : "1";
}

/** 這一盤的識別（日盤＝當天日期；夜盤＝開盤那天的日期）。nowSec 要是那一盤交易中的時間。 */
export function sessionKey(market: "0" | "1", nowSec = Date.now() / 1000): string {
	const shift = market === "1" ? 5 * 3600 : 0; // 凌晨 0～5 點還算前一天的夜盤
	const d = new Date((nowSec + TPE - shift) * 1000);
	return `${market}:${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

/**
 * 走勢圖屬於哪一盤：交易中＝這一盤；收盤中＝剛結束的那一盤（凌晨 5 點後、週末還看得到上一盤的圖）。
 * 換盤（下一盤開始交易）時才換，圖重新開始。
 */
export function tapeKey(nowSec = Date.now() / 1000): string {
	let t = nowSec;
	// 收盤中：往回找到上一個有交易的時間（每次退 15 分鐘，最多 10 天）
	for (let i = 0; i < 960 && txfSession(t) === "closed"; i++) t -= 900;
	return sessionKey(txfSession(t) === "day" ? "0" : "1", t);
}

/** 最後成交時間（HH:MM:SS，台北時間）是幾分鐘前；跨午夜也算，裝置時鐘慢一點不會變成負的一整天。看不懂回傳 null。 */
export function tradeAgeMin(time: string, nowSec = Date.now() / 1000): number | null {
	const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
	if (!m) return null;
	const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
	const d = new Date((nowSec + TPE) * 1000);
	let diff = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds() - sec;
	if (diff < -3600) diff += 86400;
	return diff / 60;
}

/** 時鐘說在交易、但最後一筆成交已經是很久以前（國定假日、颱風假）→ 其實沒開盤。 */
export const HALT_MIN = 20;
export function txfHalted(q: TxfQuote, nowSec = Date.now() / 1000): boolean {
	if (txfSession(nowSec) === "closed") return false;
	const age = tradeAgeMin(q.time, nowSec);
	return age !== null && age > HALT_MIN;
}

const n = (v: unknown): number | null => {
	if (v === null || v === undefined || v === "" || v === "-") return null;
	const x = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
	return isFinite(x) && x !== 0 ? x : null;
};

/** 從回應挑出近月台指期：跳過現貨指數（臺指現貨、代號 -S 結尾）和跨月價差（名稱有「/」）。 */
export function parseTaifex(json: unknown, market: "0" | "1"): TxfQuote {
	const j = json as { RtCode?: string; RtMsg?: string; RtData?: { QuoteList?: Record<string, unknown>[] } };
	if (!j || (j.RtCode !== undefined && String(j.RtCode) !== "0")) throw new TaifexError(`期交所回應錯誤${j?.RtMsg ? `：${j.RtMsg}` : ""}`);
	const list = j.RtData?.QuoteList ?? [];
	const q = list.find((x) => {
		const name = String(x.DispCName ?? "");
		if (name.includes("/") || name.includes("現貨") || /-S$/i.test(String(x.SymbolID ?? ""))) return false;
		return n(x.CLastPrice) !== null || n(x.CRefPrice) !== null;
	});
	if (!q) throw new TaifexError("期交所沒有台指期報價");
	const t = String(q.CTime ?? "").trim();
	return {
		name: String(q.DispCName ?? "臺指期").trim(),
		last: n(q.CLastPrice),
		ref: n(q.CRefPrice),
		high: n(q.CHighPrice),
		low: n(q.CLowPrice),
		time: /^\d{6}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}` : t,
		market,
	};
}

export async function fetchTaifex(market: "0" | "1"): Promise<TxfQuote> {
	const body = JSON.stringify({ MarketType: market, SymbolType: "F", KindID: "1", CID: "TXF", ExpireMonth: "", RowSize: "全部", PageNo: "", SortColumn: "", AscDesc: "A" });
	let res;
	try {
		res = await requestUrl({ url: TAIFEX_URL, method: "POST", contentType: "application/json", body, throw: false });
	} catch (e) {
		throw new TaifexError(`連不到期交所（${String((e as Error)?.message ?? e).slice(0, 80)}）`);
	}
	if (res.status < 200 || res.status >= 300) throw new TaifexError(`期交所 HTTP ${res.status}`, res.status);
	let json: unknown;
	try {
		json = res.json;
	} catch {
		throw new TaifexError("期交所回應格式不對");
	}
	return parseTaifex(json, market);
}

/** 收集這一盤的價格做成走勢（交易中、價格或成交時間改變時才加一點）。 */
export class TxfTape {
	private key = "";
	points: Point[] = [];
	private lastTime = "";

	constructor(private app: App) {
		const v = app.loadLocalStorage(LS_TXF_POINTS) as { key?: string; points?: Point[]; lastTime?: string } | null;
		if (v?.key && Array.isArray(v.points)) {
			this.key = v.key;
			this.points = v.points;
			this.lastTime = v.lastTime ?? "";
		}
	}

	add(q: TxfQuote, nowSec = Date.now() / 1000): Point[] {
		let changed = false;
		const key = tapeKey(nowSec);
		if (key !== this.key) {
			// 換盤了（或留著的是更早以前的圖）：重新開始
			this.key = key;
			this.points = [];
			this.lastTime = "";
			changed = true;
		}
		// 收盤中價格不會動，不加點；期交所沒給成交時間時，只看價格有沒有變
		const open = txfSession(nowSec) !== "closed";
		if (open && q.last !== null && (q.time === "" || q.time !== this.lastTime)) {
			const prev = this.points[this.points.length - 1];
			if (!prev || prev.v !== q.last || nowSec - prev.t > 300) {
				this.points.push({ t: Math.round(nowSec), v: q.last });
				if (this.points.length > MAX_POINTS) this.points.splice(0, this.points.length - MAX_POINTS);
				changed = true;
			}
			if (this.lastTime !== q.time) changed = true;
			this.lastTime = q.time;
		}
		if (changed) this.app.saveLocalStorage(LS_TXF_POINTS, { key: this.key, points: this.points, lastTime: this.lastTime });
		return this.points;
	}
}

export const SESSION_TEXT: Record<TxfSession, string> = { day: "日盤交易中", night: "夜盤交易中", closed: "收盤" };
export const HALTED_TEXT = "休市";
