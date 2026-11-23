// 個股走勢圖（v0.10.0，使用者 2026-11-23 要點代號就能看線圖）：點代號的選單「走勢圖」打開。
// 期間和市場行情頁一樣（1日～5年，這台裝置記住上次選的）；1日含盤前盤後（淺色底），每分鐘更新。
// 圖上用虛線畫出自己設的估值下限、合理價位、上限和成本——外面網站看不到的，一眼看出現價離警示線多遠。
// 華爾街目標價線：免費來源各有限制（Finnhub 要付費版、Alpha Vantage 只有平均、FMP 免費版只有約 87 檔），使用者決定先不做。
import { App, Modal } from "obsidian";
import { Row, computeRow, vsFair } from "./calc";
import { ChartLevel, drawChart } from "./chart";
import * as F from "./format";
import { isHeld } from "./holdings";
import type StockViewPlugin from "./main";
import { MarketData, RANGES, RangeDef, Series, fetchChart, rangeOf, timeLabel } from "./markets";

export const LS_STOCK_RANGE = "stockview:stock-range";
const REFRESH_MS = 60_000;

/** 個股走勢圖的資料：1日連盤前盤後一起抓；快取和市場行情頁分開（市場行情不抓盤前盤後）。 */
export function stockChartData(): MarketData {
	return new MarketData((symbol, r) => fetchChart(symbol, r, r.id === "1d"));
}

/** 圖上要畫的價位：估值下限、合理價位、上限；有持股（股數大於 0）又有成本時加成本。 */
export function chartLevels(r: Row): ChartLevel[] {
	const h = r.h;
	const out: ChartLevel[] = [];
	if (h.low !== null) out.push({ v: h.low, label: "下限", kind: "low" });
	if (h.fair !== null) out.push({ v: h.fair, label: "合理", kind: "fair" });
	if (h.high !== null) out.push({ v: h.high, label: "上限", kind: "high" });
	if (isHeld(h) && h.cost !== null) out.push({ v: h.cost, label: "成本", kind: "cost" });
	return out;
}

/** 一條價位線的說明：「下限 $90.00，現價高 12.3%」（和表格的合理價位同一個算法）。 */
export function levelText(l: ChartLevel, price: number | null, cur: string): string {
	const d = vsFair(price, l.v);
	const rel = d === null ? "" : Math.abs(d) < 0.5 ? "，現價接近" : d > 0 ? `，現價高 ${d.toFixed(1)}%` : `，現價低 ${Math.abs(d).toFixed(1)}%`;
	return `${l.label} ${F.price(l.v, cur)}${rel}`;
}

const SESSION_LABEL = { pre: "盤前", regular: "盤中", post: "盤後", closed: "收盤" } as const;

export class StockChartModal extends Modal {
	private seq = 0;
	private timer: number | null = null;
	private headEl!: HTMLElement;
	private rangesEl!: HTMLElement;
	private chartEl!: HTMLElement;
	private levelsEl!: HTMLElement;

	constructor(
		app: App,
		private plugin: StockViewPlugin,
		private row: Row,
		private data: MarketData,
	) {
		super(app);
	}

	range(): RangeDef {
		return rangeOf(String(this.app.loadLocalStorage(LS_STOCK_RANGE) ?? "1d"));
	}

	/** 最新的報價（儀表板一直在更新）；拿不到就用打開時的。 */
	private fresh(): Row {
		const q = this.plugin.feed.quotes.get(this.row.h.ticker) ?? this.row.q;
		return computeRow(this.row.h, q, this.plugin.settings.alarmUseExtended);
	}

	onOpen(): void {
		this.modalEl.addClass("sv-chart-modal");
		const root = this.contentEl;
		root.addClass("sv-root");
		root.dataset.color = this.plugin.settings.colorStyle;
		const t = this.row.h.ticker;
		const name = this.row.q?.name;
		this.setTitle(name && name !== t ? `${t}　${name}` : t);
		this.headEl = root.createDiv("sv-sc-head");
		this.rangesEl = root.createDiv("sv-ranges");
		this.chartEl = root.createDiv("sv-sc-chart");
		this.levelsEl = root.createDiv("sv-sc-levels");
		root.createDiv({ cls: "sv-foot", text: "資料：Yahoo Finance · 1日包含盤前、盤後（淺色底）· 虛線是你設的估值價位和成本 · 不構成投資建議" });
		this.renderHead();
		this.renderRanges();
		this.renderLevels();
		void this.load();
		// 1日每分鐘更新（Obsidian 在背景時不抓）
		this.timer = window.setInterval(() => {
			if (this.range().id === "1d" && !document.hidden) void this.load();
		}, REFRESH_MS);
	}

	onClose(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = null;
		this.seq++;
		this.contentEl.empty();
	}

	/** 現價、今日漲跌、盤前盤後價（和儀表板一樣的報價）。 */
	private renderHead(): void {
		const r = this.fresh();
		const q = r.q;
		this.headEl.empty();
		if (!q) {
			this.headEl.createDiv({ cls: "sv-muted", text: "報價讀取中…" });
			return;
		}
		const top = this.headEl.createDiv("sv-sc-price");
		top.createSpan({ cls: "sv-sc-last", text: F.price(q.price, r.cur) });
		top.createSpan({ cls: `sv-sc-chg sv-${F.dir(r.dayChg)}`, text: `${F.signedNum(r.dayChg)}（${F.pct(r.dayPct)}）` });
		top.createSpan({ cls: `sv-session sv-s-${q.session}`, text: SESSION_LABEL[q.session] });
		if (q.ext && q.session !== "regular" && q.price) {
			const d = ((q.ext.price - q.price) / q.price) * 100;
			this.headEl.createDiv({
				cls: `sv-sc-ext sv-${F.dir(d)}`,
				text: `${q.session === "pre" ? "盤前" : "盤後"} ${F.price(q.ext.price, r.cur)}（${F.pct(d)}）`,
			});
		}
	}

	private renderRanges(): void {
		const cur = this.range();
		this.rangesEl.empty();
		for (const x of RANGES) {
			const b = this.rangesEl.createEl("button", { cls: `sv-range-btn${x.id === cur.id ? " is-active" : ""}`, text: x.label });
			b.onclick = () => {
				this.app.saveLocalStorage(LS_STOCK_RANGE, x.id);
				this.renderRanges();
				void this.load();
			};
		}
	}

	/** 每條價位線離現價多遠（盤前盤後用延長時段價，和警示一樣）。 */
	private renderLevels(): void {
		const r = this.fresh();
		const levels = chartLevels(r);
		this.levelsEl.empty();
		if (!levels.length) {
			this.levelsEl.createDiv({ cls: "sv-muted", text: "還沒設估值價位：在選單「編輯…」填下限、合理價位、上限，圖上就會畫出來。" });
			return;
		}
		for (const l of [...levels].sort((a, b) => b.v - a.v)) this.levelsEl.createDiv({ cls: `sv-sc-level sv-lvl-${l.kind}`, text: levelText(l, r.alarmPrice, r.cur) });
	}

	async load(): Promise<void> {
		const r = this.range();
		const seq = ++this.seq;
		this.chartEl.addClass("sv-loading");
		if (!this.chartEl.childElementCount) this.chartEl.createDiv({ cls: "sv-mcard-loading", text: "讀取中…" });
		try {
			const s = await this.data.get({ symbol: this.row.h.ticker, name: this.row.h.ticker }, r);
			if (seq !== this.seq) return;
			this.draw(s, r);
		} catch (e) {
			if (seq !== this.seq) return;
			this.chartEl.empty();
			this.chartEl.createDiv({ cls: "sv-err", text: `拿不到走勢：${(e as Error)?.message ?? e}` });
		}
		this.chartEl.removeClass("sv-loading");
		this.renderHead();
		this.renderLevels();
	}

	private draw(s: Series, r: RangeDef): void {
		const row = this.fresh();
		const el = this.chartEl;
		el.empty();
		const last = s.points[s.points.length - 1]?.v ?? null;
		const chg = last !== null && s.base ? last - s.base : null;
		const pct = chg !== null && s.base ? (chg / s.base) * 100 : null;
		const dir = F.dir(chg);
		el.createDiv({ cls: `sv-sc-period sv-${dir}`, text: `${r.id === "1d" ? "比昨收" : `${r.label}來`} ${F.signedNum(chg)}（${F.pct(pct)}）` });
		if (s.points.length < 2) {
			el.createDiv({ cls: "sv-muted", text: "這段時間的資料太少，畫不出走勢。" });
			return;
		}
		const first = s.points[0].t;
		drawChart(el, {
			points: s.points,
			base: s.base,
			domain: s.domain,
			dir,
			fmtValue: (v) => F.price(v, row.cur),
			fmtTime: (t) => timeLabel(t, s.gmtoffset, r, true),
			axisStart: timeLabel(s.domain && r.id === "1d" ? s.domain[0] : first, s.gmtoffset, r),
			axisEnd: timeLabel(s.domain && r.id === "1d" ? s.domain[1] : s.points[s.points.length - 1].t, s.gmtoffset, r),
			label: `${row.h.ticker} ${r.label}走勢，最新 ${F.price(last, row.cur)}，${F.pct(pct)}`,
			levels: chartLevels(row),
			bands: s.ext,
		});
	}
}
