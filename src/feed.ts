// 定時抓報價：儀表板開著時每 5 秒（收盤 60 秒）；沒開而且有設警示時在背景檢查（開盤 30 秒、收盤 5 分鐘）。
// Yahoo 回 429（太頻繁）時間隔加倍，最多 5 分鐘，成功後恢復。
import type { App } from "obsidian";
import type { AlarmEvent } from "./alarm";
import type { Alarms } from "./alarms";
import { computeRow, Row } from "./calc";
import { BG_CLOSED_SEC, BG_OPEN_SEC, FX_SYMBOL, FX_TTL, StockViewSettings } from "./config";
import { Holding, readHoldings } from "./holdings";
import { fetchQuote, isUsTicker, Quote, QuoteError } from "./quote";
import type { Ratings } from "./ratings";

export interface FeedHost {
	app: App;
	settings: StockViewSettings;
	alarms: Alarms;
	ratings: Ratings;
	viewOpen(): boolean;
	onAlarm(events: AlarmEvent[]): void;
}

export const MAX_BACKOFF = 5 * 60_000;
const CONCURRENCY = 4;

export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
	let i = 0;
	const worker = async () => {
		while (i < items.length) await fn(items[i++]);
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export class Feed {
	quotes = new Map<string, Quote>();
	errors = new Map<string, string>();
	holdings: Holding[] = [];
	fx: number | null = null;
	fxAt = 0;
	lastRound = 0;
	nextAt = 0;
	backoff = 0;
	status = ""; // 整體錯誤（例如 Yahoo 太頻繁、離線）
	private timer: number | null = null;
	private busy = false;
	private running = false;
	private listeners = new Set<() => void>();

	constructor(private host: FeedHost) {}

	subscribe(f: () => void): () => void {
		this.listeners.add(f);
		return () => this.listeners.delete(f);
	}

	emit(): void {
		for (const f of this.listeners) {
			try {
				f();
			} catch (e) {
				console.error("StockView", e);
			}
		}
	}

	reload(): void {
		this.holdings = readHoldings(this.host.app, this.host.settings.folder);
	}

	rows(): Row[] {
		return this.holdings.map((h) => computeRow(h, this.quotes.get(h.ticker) ?? null, this.host.settings.alarmUseExtended));
	}

	/** 有任何一檔在盤前／盤中／盤後；還沒有報價時當作開盤（先抓一次再說）。 */
	marketOpen(): boolean {
		let any = false;
		for (const h of this.holdings) {
			const q = this.quotes.get(h.ticker);
			if (!q) return true;
			any = true;
			if (q.session !== "closed") return true;
		}
		return !any;
	}

	hasAlarmLines(): boolean {
		return this.holdings.some((h) => h.low !== null || h.high !== null);
	}

	shouldRun(): boolean {
		const s = this.host.settings;
		return this.host.viewOpen() || (s.alarmEnabled && s.backgroundAlarm && this.hasAlarmLines());
	}

	intervalMs(): number {
		const s = this.host.settings;
		const open = this.marketOpen();
		const sec = this.host.viewOpen() ? (open ? s.refreshSec : s.closedRefreshSec) : open ? BG_OPEN_SEC : BG_CLOSED_SEC;
		return Math.max(sec * 1000, this.backoff);
	}

	start(): void {
		this.running = true;
		this.schedule(0);
	}

	stop(): void {
		this.running = false;
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}

	/** 儀表板打開、按重新整理、改了設定或筆記時呼叫：馬上抓一次。 */
	kick(): void {
		if (!this.running) return;
		this.schedule(0);
	}

	private schedule(delay: number): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		if (!this.running) return;
		this.nextAt = Date.now() + delay;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			if (!this.shouldRun()) {
				// 沒事做：過一陣子再看（例如之後打開儀表板會 kick）
				this.reload();
				this.schedule(BG_CLOSED_SEC * 1000);
				return;
			}
			void this.round().finally(() => this.schedule(this.intervalMs()));
		}, delay);
	}

	async round(now: () => number = Date.now): Promise<AlarmEvent[]> {
		if (this.busy) return [];
		this.busy = true;
		let events: AlarmEvent[] = [];
		try {
			this.reload();
			const tickers = [...new Set(this.holdings.map((h) => h.ticker))];
			let limited = false;
			let offline = 0;
			await pool(tickers, CONCURRENCY, async (t) => {
				try {
					this.quotes.set(t, await fetchQuote(t));
					this.errors.delete(t);
				} catch (e) {
					const err = e as QuoteError;
					if (err.status === 429) limited = true;
					else if (err.status === undefined) offline++;
					this.errors.set(t, err.message ?? String(e));
				}
			});
			await this.updateFx(now());
			this.backoff = limited ? Math.min(MAX_BACKOFF, Math.max(30_000, this.backoff * 2)) : 0;
			this.status = limited
				? `Yahoo 請求太頻繁，${Math.round(this.backoff / 1000)} 秒後再試`
				: tickers.length && offline === tickers.length
					? "連不到網路，稍後自動重試"
					: "";
			this.lastRound = now();
			const s = this.host.settings;
			if (s.alarmEnabled) {
				const items = this.rows().map((r) => ({ ticker: r.h.ticker, low: r.h.low, high: r.h.high, price: r.alarmPrice }));
				events = this.host.alarms.check(items, { bufferPct: s.alarmBufferPct, cooldownMin: s.alarmCooldownMin }, now());
				if (events.length) this.host.onAlarm(events);
			}
			if (s.showRatings && this.host.viewOpen()) void this.host.ratings.refresh(tickers.filter(isUsTicker));
		} finally {
			this.busy = false;
			this.emit();
		}
		return events;
	}

	/** 需要換算幣別時（總計用台幣，或有台股）才抓美元兌台幣，10 分鐘一次。 */
	private async updateFx(now: number): Promise<void> {
		const base = this.host.settings.base;
		const need = this.rows().some((r) => r.h.shares !== null && r.cur !== base);
		if (!need || now - this.fxAt < FX_TTL) return;
		try {
			const q = await fetchQuote(FX_SYMBOL);
			if (q.price) {
				this.fx = q.price;
				this.fxAt = now;
			}
		} catch {
			// 下次再試；畫面會標示「匯率暫用」
		}
	}
}
