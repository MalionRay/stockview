// 設定（data.json；不放任何金鑰）與共用常數。
import type { Base } from "./calc";

export const VIEW_TYPE = "stockview-dashboard";

export interface StockViewSettings {
	folder: string; // 股票筆記所在資料夾
	refreshSec: number; // 儀表板開著、市場開盤（含盤前盤後）時
	closedRefreshSec: number; // 儀表板開著、收盤時
	base: Base; // 總計幣別
	colorStyle: "tw" | "us"; // tw＝紅漲綠跌，us＝綠漲紅跌
	showRatings: boolean;
	alarmEnabled: boolean;
	alarmUseExtended: boolean; // 盤前盤後也判斷
	alarmBufferPct: number;
	alarmCooldownMin: number;
	alarmSound: boolean;
	backgroundAlarm: boolean; // 儀表板沒開時也在背景檢查
}

export const DEFAULT_SETTINGS: StockViewSettings = {
	folder: "Portfolio",
	refreshSec: 5,
	closedRefreshSec: 60,
	base: "USD",
	colorStyle: "tw",
	showRatings: true,
	alarmEnabled: true,
	alarmUseExtended: true,
	alarmBufferPct: 1,
	alarmCooldownMin: 30,
	alarmSound: true,
	backgroundAlarm: true,
};

/** 背景檢查（儀表板沒開）時的間隔：開盤 30 秒、收盤 5 分鐘。 */
export const BG_OPEN_SEC = 30;
export const BG_CLOSED_SEC = 300;
export const FX_TTL = 10 * 60_000;
export const FX_SYMBOL = "TWD=X";

export function sanitizeSettings(s: Partial<StockViewSettings> & Record<string, unknown>): StockViewSettings {
	const o: StockViewSettings = { ...DEFAULT_SETTINGS };
	for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof StockViewSettings)[])
		if (s[k] !== undefined && typeof s[k] === typeof DEFAULT_SETTINGS[k]) (o as unknown as Record<string, unknown>)[k] = s[k];
	o.refreshSec = clamp(o.refreshSec, 3, 600);
	o.closedRefreshSec = clamp(o.closedRefreshSec, 10, 3600);
	o.alarmBufferPct = clamp(o.alarmBufferPct, 0, 20);
	o.alarmCooldownMin = clamp(o.alarmCooldownMin, 0, 1440);
	if (o.base !== "USD" && o.base !== "TWD") o.base = "USD";
	if (o.colorStyle !== "tw" && o.colorStyle !== "us") o.colorStyle = "tw";
	o.folder = o.folder.trim().replace(/^\/+|\/+$/g, "") || "Portfolio";
	return o;
}

function clamp(v: number, lo: number, hi: number): number {
	return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
