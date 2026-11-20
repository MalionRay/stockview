// 警示的狀態與訊息：存在這台裝置的 localStorage（每台裝置各自響，不互相影響；重開 Obsidian 不會重響）。
// 每個清單的每一檔各自判斷（key＝清單|代號）；同一輪同一檔同一條線在好幾個清單都響時只通知一次。
// 警示訊息（v0.9.0）：響過的都留著，直到使用者自己刪（最多 INBOX_MAX 則，太多才從最舊的丟）；
// 還沒看過的算未讀，打開「警示訊息」就算看過。
import type { App } from "obsidian";
import { AlarmCfg, AlarmEvent, AlarmState, checkAlarm } from "./alarm";

export const LS_ALARM_STATE = "stockview:alarm-state";
export const LS_ALARM_LOG = "stockview:alarm-log"; // 警示訊息（沿用舊的紀錄 key，舊紀錄當成已讀的訊息）
export const INBOX_MAX = 300;

export interface AlarmMessage extends AlarmEvent {
	id: string;
	read?: boolean; // 看過了（打開過警示訊息）
}

let seq = 0;
function newId(at: number): string {
	return `${at.toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface AlarmItem {
	list: string;
	ticker: string;
	low: number | null;
	high: number | null;
	fair?: number | null;
	price: number | null;
}

export function alarmKey(list: string, ticker: string): string {
	return `${list}|${ticker}`;
}

export class Alarms {
	private states: Record<string, AlarmState>;
	/** 警示訊息，最新的在前面。 */
	log: AlarmMessage[];
	private listeners = new Set<() => void>();

	constructor(private app: App) {
		this.states = (app.loadLocalStorage(LS_ALARM_STATE) as Record<string, AlarmState> | null) ?? {};
		const l = app.loadLocalStorage(LS_ALARM_LOG);
		const raw = Array.isArray(l) ? (l as Partial<AlarmMessage>[]) : [];
		// 舊版的紀錄沒有 id：補上，當成已經看過的訊息
		this.log = raw
			.filter((e) => e && typeof e.ticker === "string" && typeof e.at === "number")
			.map((e) => (e.id ? (e as AlarmMessage) : { ...(e as AlarmEvent), id: newId(e.at!), read: true }));
	}

	/** 警示訊息有變（新的、看過、刪掉）時通知；回傳取消的函式。 */
	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => void this.listeners.delete(fn);
	}

	private saveLog(): void {
		this.app.saveLocalStorage(LS_ALARM_LOG, this.log);
		for (const fn of [...this.listeners]) {
			try {
				fn();
			} catch {
				/* 畫面的錯不影響警示 */
			}
		}
	}

	/** 還沒看過的訊息數。 */
	unread(): number {
		return this.log.filter((e) => !e.read).length;
	}

	/** 打開警示訊息：全部算看過。 */
	markRead(): void {
		if (!this.log.some((e) => !e.read)) return;
		this.log = this.log.map((e) => (e.read ? e : { ...e, read: true }));
		this.saveLog();
	}

	/** 刪掉一則（或幾則）訊息。 */
	remove(ids: string[]): void {
		const del = new Set(ids);
		const next = this.log.filter((e) => !del.has(e.id));
		if (next.length === this.log.length) return;
		this.log = next;
		this.saveLog();
	}

	/** 檢查每一檔，回傳這次新響的警示。 */
	check(items: AlarmItem[], cfg: AlarmCfg, now = Date.now()): AlarmEvent[] {
		const out: AlarmEvent[] = [];
		const seen = new Set<string>();
		let changed = false;
		for (const it of items) {
			const key = alarmKey(it.list, it.ticker);
			const prev = this.states[key];
			const { state, events } = checkAlarm(prev, it, it.price, now, cfg);
			if (JSON.stringify(prev) !== JSON.stringify(state)) {
				this.states[key] = state;
				changed = true;
			}
			for (const e of events) {
				const k = `${e.ticker}|${e.kind}|${e.line}`;
				if (seen.has(k)) continue;
				seen.add(k);
				out.push({ ...e, list: it.list || undefined });
			}
		}
		// 不在清單上的股票狀態先留著（啟動時筆記快取還沒好，清單可能暫時是空的，刪了會重響）
		if (changed) this.app.saveLocalStorage(LS_ALARM_STATE, this.states);
		if (out.length) {
			const msgs = [...out].reverse().map((e) => ({ ...e, id: newId(e.at), read: false }));
			this.log = [...msgs, ...this.log].slice(0, INBOX_MAX);
			this.saveLog();
		}
		return out;
	}

	/** 全部刪掉。 */
	clearLog(): void {
		if (!this.log.length) return;
		this.log = [];
		this.saveLog();
	}

	/** 是否處於「已響、等價格回到界線內」的狀態（畫面上顯示 🔕）。 */
	waiting(lists: string[], ticker: string): { high: boolean; low: boolean } {
		let high = false;
		let low = false;
		for (const l of lists) {
			const s = this.states[alarmKey(l, ticker)];
			if (s && !s.highArmed) high = true;
			if (s && !s.lowArmed) low = true;
		}
		return { high, low };
	}
}
