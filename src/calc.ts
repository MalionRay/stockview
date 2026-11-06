// 損益計算（純函式）：每檔的市值、未實現損益、今日漲跌，與換算成同一幣別的總計。
import type { Holding } from "./holdings";
import type { Quote } from "./quote";

export type Base = "USD" | "TWD";

export const FX_FALLBACK = 32; // 還沒抓到匯率時的暫用值（畫面會標示）

export interface Row {
	h: Holding;
	q: Quote | null;
	cur: string;
	value: number | null;
	costTotal: number | null;
	pl: number | null;
	plPct: number | null;
	dayChg: number | null; // 每股
	dayPct: number | null;
	dayPl: number | null; // 持股今日損益
	alarmPrice: number | null; // 判斷警示用的價格（盤前盤後時用延長時段價）
}

export function guessCurrency(ticker: string): string {
	return /\.(TW|TWO)$/.test(ticker) ? "TWD" : "USD";
}

/** 判斷警示、估值區間用的價格：開啟「延長時段」且現在不是盤中時，用盤前／盤後價。 */
export function effectivePrice(q: Quote | null, useExtended: boolean): number | null {
	if (!q) return null;
	if (useExtended && q.ext && q.session !== "regular") return q.ext.price;
	return q.price;
}

export function computeRow(h: Holding, q: Quote | null, useExtended = true): Row {
	const cur = q?.currency || guessCurrency(h.ticker);
	const price = q?.price ?? null;
	const has = price !== null && h.shares !== null;
	const value = has ? price! * h.shares! : null;
	const costTotal = h.shares !== null && h.cost !== null ? h.cost * h.shares : null;
	const pl = value !== null && costTotal !== null ? value - costTotal : null;
	const plPct = pl !== null && costTotal ? (pl / costTotal) * 100 : null;
	const dayChg = price !== null && q?.prevClose ? price - q.prevClose : null;
	const dayPct = dayChg !== null && q?.prevClose ? (dayChg / q.prevClose) * 100 : null;
	const dayPl = dayChg !== null && h.shares !== null ? dayChg * h.shares : null;
	return { h, q, cur, value, costTotal, pl, plPct, dayChg, dayPct, dayPl, alarmPrice: effectivePrice(q, useExtended) };
}

/** 換算成總計幣別。fx＝1 美元兌多少台幣。 */
export function toBase(v: number, cur: string, base: Base, fx: number | null): number {
	const r = fx ?? FX_FALLBACK;
	if (cur === base) return v;
	if (cur === "USD" && base === "TWD") return v * r;
	if (cur === "TWD" && base === "USD") return v / r;
	return v; // 其他幣別先不換算
}

export interface Totals {
	value: number;
	cost: number;
	pl: number;
	plPct: number | null;
	day: number;
	dayPct: number | null;
	needsFx: boolean; // 有用到匯率換算
	fxMissing: boolean; // 需要匯率但還沒抓到（用暫用值）
	missing: number; // 有股數但還沒有報價的檔數
}

export function totals(rows: Row[], base: Base, fx: number | null): Totals {
	let value = 0;
	let cost = 0;
	let day = 0;
	let missing = 0;
	let needsFx = false;
	for (const r of rows) {
		if (r.h.shares === null) continue; // 只追蹤
		if (r.cur !== base) needsFx = true;
		if (r.value === null) {
			missing++;
			continue;
		}
		value += toBase(r.value, r.cur, base, fx);
		if (r.costTotal !== null) cost += toBase(r.costTotal, r.cur, base, fx);
		if (r.dayPl !== null) day += toBase(r.dayPl, r.cur, base, fx);
	}
	// 沒填成本的持股不算進損益：損益＝有成本的市值 − 成本
	let valueWithCost = 0;
	for (const r of rows) if (r.value !== null && r.costTotal !== null) valueWithCost += toBase(r.value, r.cur, base, fx);
	const pl = valueWithCost - cost;
	const prev = value - day;
	return {
		value,
		cost,
		pl,
		plPct: cost ? (pl / cost) * 100 : null,
		day,
		dayPct: prev ? (day / prev) * 100 : null,
		needsFx,
		fxMissing: needsFx && fx === null,
		missing,
	};
}

/** 估值區間：價格在區間的哪裡（0～100%，超出就夾住），以及是否突破／跌破。 */
export function rangeState(price: number | null, low: number | null, high: number | null): { state: "above" | "below" | "inside" | null; pos: number | null } {
	if (price === null || (low === null && high === null)) return { state: null, pos: null };
	const state = high !== null && price >= high ? "above" : low !== null && price <= low ? "below" : "inside";
	const pos = low !== null && high !== null && high > low ? Math.max(0, Math.min(100, ((price - low) / (high - low)) * 100)) : null;
	return { state, pos };
}
