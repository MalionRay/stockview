// 市場行情頁：美股／台股／日股／陸股／韓股／歐股的主要指數，和各國貨幣對台幣的匯率，每個都有走勢圖。
// 上面一排切換市場，下面一排切換期間（1日～5年），整頁共用。1日每分鐘自動更新，其他期間打開或切換時更新。
import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { drawChart } from "./chart";
import * as F from "./format";
import type StockViewPlugin from "./main";
import { MARKETS, Market, MarketData, MarketItem, RANGES, RangeDef, Series, fmtLevel, rangeOf, timeLabel } from "./markets";

export const MARKET_VIEW = "stockview-markets";
export const LS_MARKET_TAB = "stockview:market-tab";
export const LS_MARKET_RANGE = "stockview:market-range";
const REFRESH_MS = 60_000;

export class MarketsView extends ItemView {
	data: MarketData;
	private tabsEl!: HTMLElement;
	private rangesEl!: HTMLElement;
	private gridEl!: HTMLElement;
	private noteEl!: HTMLElement;
	private seq = 0;
	private timer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: StockViewPlugin,
		data?: MarketData,
	) {
		super(leaf);
		this.data = data ?? new MarketData();
	}

	getViewType(): string {
		return MARKET_VIEW;
	}
	getDisplayText(): string {
		return "市場行情";
	}
	getIcon(): string {
		return "globe";
	}

	market(): Market {
		const id = this.app.loadLocalStorage(LS_MARKET_TAB);
		return MARKETS.find((m) => m.id === id) ?? MARKETS[0];
	}

	range(): RangeDef {
		return rangeOf(String(this.app.loadLocalStorage(LS_MARKET_RANGE) ?? "1d"));
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("sv-root");
		root.addClass("sv-markets");
		const head = root.createDiv("sv-head");
		head.createEl("h2", { text: "市場行情" });
		const btns = head.createDiv("sv-btns");
		const back = btns.createEl("button", { attr: { "aria-label": "持股儀表板" } });
		setIcon(back.createSpan("sv-btn-icon"), "line-chart");
		back.createSpan({ cls: "sv-btn-text", text: "持股" });
		back.onclick = () => void this.plugin.openDashboard();
		const refresh = btns.createEl("button", { attr: { "aria-label": "重新整理" } });
		setIcon(refresh.createSpan("sv-btn-icon"), "refresh-cw");
		refresh.createSpan({ cls: "sv-btn-text", text: "重新整理" });
		refresh.onclick = () => void this.load(true);

		this.tabsEl = root.createDiv("sv-lists sv-market-tabs");
		this.rangesEl = root.createDiv("sv-ranges");
		this.noteEl = root.createDiv("sv-notices");
		this.gridEl = root.createDiv("sv-market-grid");
		root.createDiv({ cls: "sv-foot", text: "資料：Yahoo Finance（免費，台股、日股、陸股、韓股、歐股可能延遲 15～20 分鐘）· 時間是各交易所當地時間 · 不構成投資建議" });
		this.contentEl.dataset.color = this.plugin.settings.colorStyle;
		this.renderBars();
		await this.load();
		this.timer = window.setInterval(() => {
			if (this.range().id === "1d") void this.load();
		}, REFRESH_MS);
		this.registerInterval(this.timer);
	}

	async onClose(): Promise<void> {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.seq++;
	}

	private renderBars(): void {
		const cur = this.market();
		this.tabsEl.empty();
		for (const m of MARKETS) {
			const b = this.tabsEl.createEl("button", { cls: `sv-list-tab${m.id === cur.id ? " is-active" : ""}`, text: m.label });
			b.onclick = () => {
				this.app.saveLocalStorage(LS_MARKET_TAB, m.id);
				this.renderBars();
				this.gridEl.empty();
				void this.load();
			};
		}
		const r = this.range();
		this.rangesEl.empty();
		for (const x of RANGES) {
			const b = this.rangesEl.createEl("button", { cls: `sv-range-btn${x.id === r.id ? " is-active" : ""}`, text: x.label });
			b.onclick = () => {
				this.app.saveLocalStorage(LS_MARKET_RANGE, x.id);
				this.renderBars();
				void this.load();
			};
		}
	}

	/** 抓目前市場、目前期間的所有項目；抓的時候先保留舊圖（變淡），不閃爍。 */
	async load(force = false): Promise<void> {
		const seq = ++this.seq;
		const m = this.market();
		const r = this.range();
		if (force) this.data.clear();
		this.noteEl.empty();
		const cards = new Map<string, HTMLElement>();
		// 同一個市場換期間：先留著舊圖（變淡）；換市場才清掉
		if (this.gridEl.dataset.market !== m.id) this.gridEl.empty();
		this.gridEl.dataset.market = m.id;
		for (const item of m.items) {
			let card = Array.from(this.gridEl.children).find((c) => (c as HTMLElement).dataset.symbol === item.symbol) as HTMLElement | undefined;
			if (!card) {
				card = this.gridEl.createDiv({ cls: "sv-mcard", attr: { "data-symbol": item.symbol } });
				const cached = this.data.cached(item, r);
				if (cached) this.fillCard(card, item, m, r, cached);
				else card.createDiv({ cls: "sv-mcard-loading", text: `${item.name}　讀取中…` });
			}
			card.addClass("sv-loading");
			cards.set(item.symbol, card);
		}
		let limited = false;
		await Promise.all(
			m.items.map(async (item) => {
				const card = cards.get(item.symbol)!;
				try {
					const s = await this.data.get(item, r);
					if (seq !== this.seq) return;
					this.fillCard(card, item, m, r, s);
				} catch (e) {
					if (seq !== this.seq) return;
					if ((e as { status?: number }).status === 429) limited = true;
					card.empty();
					card.removeClass("sv-loading");
					card.createDiv({ cls: "sv-mcard-name", text: item.name });
					card.createDiv({ cls: "sv-err", text: `拿不到資料：${(e as Error)?.message ?? e}` });
				}
			}),
		);
		if (seq === this.seq && limited) this.noteEl.createDiv({ cls: "sv-notice sv-warn", text: "Yahoo 請求太頻繁，過一兩分鐘再按重新整理" });
	}

	fillCard(card: HTMLElement, item: MarketItem, m: Market, r: RangeDef, s: Series): void {
		card.empty();
		card.removeClass("sv-loading");
		const fx = !!m.fx;
		const chg = s.last !== null && s.base ? s.last - s.base : null;
		const pct = chg !== null && s.base ? (chg / s.base) * 100 : null;
		const dir = F.dir(chg);

		const top = card.createDiv("sv-mcard-top");
		const name = top.createDiv("sv-mcard-name");
		name.createSpan({ text: item.name });
		name.createSpan({ cls: "sv-muted sv-mcard-sym", text: item.symbol });
		if (!fx) {
			const st = s.session === "regular" ? "交易中" : s.session === "closed" ? "收盤" : s.session === "pre" ? "盤前" : "盤後";
			top.createSpan({ cls: `sv-session sv-s-${s.session}`, text: st });
		}
		const val = card.createDiv("sv-mcard-val");
		val.createSpan({ cls: "sv-mcard-last", text: fmtLevel(s.last, fx) });
		if (fx && item.unit) val.createSpan({ cls: "sv-muted", text: ` 台幣／${item.unit}` });
		const c = card.createDiv(`sv-mcard-chg sv-${dir}`);
		c.setText(`${F.signedNum(chg, fx ? 3 : 2)}（${F.pct(pct)}）`);
		card.createSpan({ cls: "sv-muted sv-mcard-period", text: r.id === "1d" ? "比昨收" : `${r.label}來` });

		if (s.points.length > 1) {
			const first = s.points[0].t;
			const last = s.points[s.points.length - 1].t;
			const end = s.domain && r.id === "1d" ? s.domain[1] : last;
			drawChart(card, {
				points: s.points,
				base: s.base,
				domain: s.domain,
				dir,
				fmtValue: (v) => fmtLevel(v, fx),
				fmtTime: (t) => timeLabel(t, s.gmtoffset, r, true),
				axisStart: timeLabel(s.domain && r.id === "1d" ? s.domain[0] : first, s.gmtoffset, r),
				axisEnd: timeLabel(end, s.gmtoffset, r),
				label: `${item.name} ${r.label}走勢，最新 ${fmtLevel(s.last, fx)}，${F.pct(pct)}`,
			});
		}
	}
}
