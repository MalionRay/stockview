// 警示的狀態與紀錄：存在這台裝置的 localStorage（每台裝置各自響，不互相影響；重開 Obsidian 不會重響）。
// 每個清單的每一檔各自判斷（key＝清單|代號）；同一輪同一檔同一條線在好幾個清單都響時只通知一次。
import type { App } from "obsidian";
import { AlarmCfg, AlarmEvent, AlarmState, checkAlarm } from "./alarm";

export const LS_ALARM_STATE = "stockview:alarm-state";
export const LS_ALARM_LOG = "stockview:alarm-log";
const LOG_MAX = 50;

export interface AlarmItem {
	list: string;
	ticker: string;
	low: number | null;
	high: number | null;
	price: number | null;
}

export function alarmKey(list: string, ticker: string): string {
	return `${list}|${ticker}`;
}

export class Alarms {
	private states: Record<string, AlarmState>;
	log: AlarmEvent[];

	constructor(private app: App) {
		this.states = (app.loadLocalStorage(LS_ALARM_STATE) as Record<string, AlarmState> | null) ?? {};
		const l = app.loadLocalStorage(LS_ALARM_LOG);
		this.log = Array.isArray(l) ? (l as AlarmEvent[]) : [];
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
			this.log = [...[...out].reverse(), ...this.log].slice(0, LOG_MAX);
			this.app.saveLocalStorage(LS_ALARM_LOG, this.log);
		}
		return out;
	}

	clearLog(): void {
		this.log = [];
		this.app.saveLocalStorage(LS_ALARM_LOG, this.log);
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
