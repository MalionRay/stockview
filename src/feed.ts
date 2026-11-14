// 定時抓報價：儀表板「看得到」時每 5 秒（收盤 60 秒）；看不到（別的分頁、Obsidian 在背景）或沒開時，
// 有設警示就在背景檢查（開盤 30 秒、收盤 5 分鐘）。Yahoo 回 429（太頻繁）時間隔加倍，最多 5 分鐘，成功後恢復。
import type { App } from "obsidian";
import type { AlarmEvent } from "./alarm";
import type { Alarms } from "./alarms";
import { computeRow, Row } from "./calc";
import { BG_CLOSED_SEC, BG_OPEN_SEC, FX_SYMBOL, FX_TTL, StockViewSettings } from "./config";
import { ALL_LISTS, Holding, mergeAcrossLists, readHoldings, readLists, visibleLists } from "./holdings";
import { Account, NO_ACCOUNT, hasAccount, readAccount } from "./account";
import { fetchQuote, isUsTicker, Quote, QuoteError } from "./quote";
import type { Ratings } from "./ratings";

export interface FeedHost {
	app: App;
	settings: StockViewSettings;
	alarms: Alarms;
	ratings: Ratings;
	/** 有已經載入的儀表板分頁（不管現在看不看得到）。 */
	viewOpen(): boolean;
	/** 儀表板現在看得到（是目前的分頁，而且 Obsidian 在前景）。沒提供就當作「開著＝看得到」。 */
	viewVisible?(): boolean;
	onAlarm(events: AlarmEvent[]): void;
}

export const MAX_BACKOFF = 5 * 60_000;
/** 查不到的代號（404）隔這麼久才再試一次，不然每一輪都白問。按「重新整理」會馬上重試。 */
export const NOT_FOUND_RETRY = 10 * 60_000;
/** 一檔報價最多等這麼久；逾時當作連不上（請求卡住時不會讓整個更新停擺）。 */
export const FETCH_TIMEOUT = 20_000;
const CONCURRENCY = 4;

export async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
	let i = 0;
	const worker = async () => {
		while (i < items.length) await fn(items[i++]);
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = window.setTimeout(() => reject(new QuoteError("連線逾時", undefined, true)), ms);
		p.then(
			(v) => {
				window.clearTimeout(id);
				resolve(v);
			},
			(e) => {
				window.clearTimeout(id);
				reject(e);
			},
		);
	});
}

export class Feed {
	quotes = new Map<string, Quote>();
	errors = new Map<string, string>();
	holdings: Holding[] = []; // 每個清單各自的持股（同一清單同一檔已合併）
	lists: string[] = [];
	account: Account = NO_ACCOUNT; // 投資金額與現金（股票資料夾裡的「帳戶.md」）
	fx: number | null = null;
	fxAt = 0;
	lastRound = 0;
	nextAt = 0;
	backoff = 0;
	status = ""; // 整體錯誤（例如 Yahoo 太頻繁、離線）
	private notFound = new Map<string, number>(); // 代號 → 上次查不到的時間
	private timer: number | null = null;
	private busy = false;
	private again = false; // 更新進行中又被要求更新：這一輪結束後馬上再跑一次
	private running = false;
	private listeners = new Set<() => void>();

	constructor(
		private host: FeedHost,
		private fetcher: (ticker: string) => Promise<Quote> = fetchQuote,
		private timeoutMs = FETCH_TIMEOUT,
	) {}

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
		this.lists = readLists(this.host.app, this.host.settings.folder, this.holdings);
		this.account = readAccount(this.host.app, this.host.settings.folder, this.host.settings.base);
	}

	/** 畫面上看得到的清單（主清單沒有股票、又有其他清單時不算）。 */
	visibleLists(): string[] {
		return visibleLists(this.lists, this.holdings);
	}

	/** 某個清單的列；ALL_LISTS（預設）＝全部清單，同一檔合併成一列。 */
	rows(list: string = ALL_LISTS): Row[] {
		const hs = list === ALL_LISTS ? mergeAcrossLists(this.holdings) : this.holdings.filter((h) => h.list === list);
		return hs.map((h) => computeRow(h, this.quotes.get(h.ticker) ?? null, this.host.settings.alarmUseExtended));
	}

	/** 每個清單各自的列（警示用）。 */
	private listRows(): Row[] {
		return this.holdings.map((h) => computeRow(h, this.quotes.get(h.ticker) ?? null, this.host.settings.alarmUseExtended));
	}

	/**
	 * 要不要用「開盤」的頻率：有任何一檔在盤前／盤中／盤後，或有還沒抓過的代號（先抓一次再說）。
	 * 抓不到的代號（打錯、下市、離線）不算，不然會一直卡在開盤的頻率。
	 */
	marketOpen(): boolean {
		if (!this.holdings.length) return true; // 沒有股票：每一輪只重讀清單，不發請求
		let pending = false;
		for (const h of this.holdings) {
			const q = this.quotes.get(h.ticker);
			if (!q) {
				if (!this.errors.has(h.ticker)) pending = true;
				continue;
			}
			if (q.session !== "closed") return true;
		}
		return pending;
	}

	hasAlarmLines(): boolean {
		return this.holdings.some((h) => h.low !== null || h.high !== null);
	}

	private visible(): boolean {
		return this.host.viewVisible ? this.host.viewVisible() : this.host.viewOpen();
	}

	shouldRun(): boolean {
		const s = this.host.settings;
		return this.host.viewOpen() || (s.alarmEnabled && s.backgroundAlarm && this.hasAlarmLines());
	}

	intervalMs(): number {
		const s = this.host.settings;
		const open = this.marketOpen();
		const sec = this.visible() ? (open ? s.refreshSec : s.closedRefreshSec) : open ? BG_OPEN_SEC : BG_CLOSED_SEC;
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

	/** 儀表板打開或切回來、改了設定或筆記時呼叫：馬上抓一次（正在抓就等這一輪結束後再抓一次）。 */
	kick(): void {
		if (!this.running) return;
		if (this.busy) {
			this.again = true;
			return;
		}
		this.schedule(0);
	}

	/** 使用者按「重新整理」：連之前查不到的代號也馬上重試。 */
	refreshNow(): void {
		this.notFound.clear();
		this.kick();
	}

	private schedule(delay: number): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		if (!this.running) return;
		this.nextAt = Date.now() + delay;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.reload(); // 先重讀清單：啟動後第一次才知道有沒有警示線
			if (!this.shouldRun()) {
				// 沒事做：過一陣子再看（之後打開儀表板會 kick）
				this.schedule(BG_CLOSED_SEC * 1000);
				return;
			}
			void this.round().finally(() => {
				const again = this.again;
				this.again = false;
				this.schedule(again ? 0 : this.intervalMs());
			});
		}, delay);
	}

	async round(now: () => number = Date.now): Promise<AlarmEvent[]> {
		if (this.busy) return [];
		this.busy = true;
		let events: AlarmEvent[] = [];
		try {
			this.reload();
			const all = [...new Set(this.holdings.map((h) => h.ticker))];
			const t0 = now();
			const tickers = all.filter((t) => t0 - (this.notFound.get(t) ?? -Infinity) >= NOT_FOUND_RETRY);
			let limited = false;
			let offline = 0;
			await pool(tickers, CONCURRENCY, async (t) => {
				try {
					this.quotes.set(t, await withTimeout(this.fetcher(t), this.timeoutMs));
					this.errors.delete(t);
					this.notFound.delete(t);
				} catch (e) {
					const err = e as QuoteError;
					if (err.status === 429) limited = true;
					else if (err.status === 404) this.notFound.set(t, now());
					else if (err.network) offline++;
					this.errors.set(t, err.message ?? String(e));
				}
			});
			// 已經不在清單上的代號：錯誤和「查不到」的記錄不用留
			for (const t of [...this.errors.keys()]) if (!all.includes(t)) this.errors.delete(t);
			for (const t of [...this.notFound.keys()]) if (!all.includes(t)) this.notFound.delete(t);
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
				const items = this.listRows().map((r) => ({ list: r.h.list, ticker: r.h.ticker, low: r.h.low, high: r.h.high, price: r.alarmPrice }));
				events = this.host.alarms.check(items, { bufferPct: s.alarmBufferPct, cooldownMin: s.alarmCooldownMin }, now());
				if (events.length) this.host.onAlarm(events);
			}
			if (s.showRatings && this.host.viewOpen()) void this.host.ratings.refresh(all.filter(isUsTicker));
		} finally {
			this.busy = false;
			this.emit();
		}
		return events;
	}

	/** 需要換算幣別時（總計用台幣、有台股，或投資金額／現金的幣別和總計不同）才抓美元兌台幣，10 分鐘一次。 */
	private async updateFx(now: number): Promise<void> {
		const base = this.host.settings.base;
		const need = this.rows().some((r) => r.h.shares !== null && r.cur !== base) || (hasAccount(this.account) && this.account.currency !== base);
		if (!need || now - this.fxAt < FX_TTL) return;
		try {
			const q = await withTimeout(this.fetcher(FX_SYMBOL), this.timeoutMs);
			if (q.price) {
				this.fx = q.price;
				this.fxAt = now;
			}
		} catch {
			// 下次再試；畫面會標示「匯率暫用」
		}
	}
}
