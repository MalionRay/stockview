// 價格警示（純函式）：突破上限或跌破下限時響一次。
// - 緩衝區：響過之後，價格要回到界線內 bufferPct% 才會重新啟動（震盪期不會一直響）
// - 冷卻時間：同一檔響過之後 cooldownMin 分鐘內不再響
export interface AlarmState {
	highArmed: boolean;
	lowArmed: boolean;
	last: number | null; // 上次響的時間（ms）；null＝還沒響過
	hi?: number | null; // 上次看到的上限／下限：改了界線就重新待命
	lo?: number | null;
}

export interface AlarmCfg {
	bufferPct: number;
	cooldownMin: number;
}

export interface AlarmEvent {
	ticker: string;
	list?: string; // 哪個清單的警示線（"" 是主清單）
	kind: "high" | "low";
	line: number;
	price: number;
	at: number;
}

export function freshState(): AlarmState {
	return { highArmed: true, lowArmed: true, last: null };
}

export function checkAlarm(
	prev: AlarmState | undefined,
	h: { ticker: string; low: number | null; high: number | null },
	price: number | null,
	now: number,
	cfg: AlarmCfg,
): { state: AlarmState; events: AlarmEvent[] } {
	const s: AlarmState = { ...(prev ?? freshState()) };
	if (s.hi !== undefined && s.hi !== h.high) s.highArmed = true;
	if (s.lo !== undefined && s.lo !== h.low) s.lowArmed = true;
	s.hi = h.high;
	s.lo = h.low;
	const events: AlarmEvent[] = [];
	if (price === null || !isFinite(price)) return { state: s, events };
	const buf = Math.max(0, cfg.bufferPct) / 100;
	const cooling = () => s.last !== null && now - s.last < cfg.cooldownMin * 60_000;
	if (h.high !== null) {
		if (s.highArmed && price >= h.high && !cooling()) {
			events.push({ ticker: h.ticker, kind: "high", line: h.high, price, at: now });
			s.highArmed = false;
			s.last = now;
		} else if (!s.highArmed && price < h.high * (1 - buf)) s.highArmed = true;
	} else s.highArmed = true;
	// 冷卻中沒響的那一次，警示仍保持「待命」：冷卻結束時價格還在線外就會響
	if (h.low !== null) {
		if (s.lowArmed && price <= h.low && !cooling()) {
			events.push({ ticker: h.ticker, kind: "low", line: h.low, price, at: now });
			s.lowArmed = false;
			s.last = now;
		} else if (!s.lowArmed && price > h.low * (1 + buf)) s.lowArmed = true;
	} else s.lowArmed = true;
	return { state: s, events };
}

export function alarmText(e: AlarmEvent): string {
	const p = e.price.toLocaleString("en-US", { maximumFractionDigits: 2 });
	const where = e.list ? `（${e.list}）` : "";
	return e.kind === "high" ? `${e.ticker} 突破上限 ${e.line}，現價 ${p}${where}` : `${e.ticker} 跌破下限 ${e.line}，現價 ${p}${where}`;
}
