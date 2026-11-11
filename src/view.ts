// 儀表板：總計卡片＋持股表格（現價、今日漲跌、盤前盤後、市值、損益、估值區間、華爾街評級）＋警示紀錄。
// 每次更新只重畫內容，不換掉外框，表格的左右捲動位置會留著。
import { ItemView, Menu, WorkspaceLeaf, setIcon } from "obsidian";
import { alarmText } from "./alarm";
import { Row, rangeState, toBase, totals, fairPos, vsFair } from "./calc";
import { VIEW_TYPE } from "./config";
import * as F from "./format";
import { ALL_LISTS, Holding, MAIN_LIST, listLabel } from "./holdings";
import type StockViewPlugin from "./main";
import { SESSION_LABEL, Session, isUsTicker } from "./quote";
import { ratingInfo } from "./ratings";
import { unlockAudio } from "./sound";

export const LS_SORT = "stockview:sort";
type SortKey = "ticker" | "price" | "day" | "value" | "pl" | "range" | "rating";

interface Col {
	label: string;
	key?: SortKey;
	cls?: string;
}

const COLS: Col[] = [
	{ label: "股票", key: "ticker", cls: "sv-c-name" },
	{ label: "現價", key: "price", cls: "sv-num" },
	{ label: "今日漲跌", key: "day", cls: "sv-num" },
	{ label: "盤前／盤後", cls: "sv-num" },
	{ label: "股數／成本", cls: "sv-num" },
	{ label: "市值", key: "value", cls: "sv-num" },
	{ label: "未實現損益", key: "pl", cls: "sv-num" },
	{ label: "估值區間", key: "range", cls: "sv-c-range" },
	{ label: "華爾街評級", key: "rating", cls: "sv-c-rating" },
];

export class DashboardView extends ItemView {
	private unsub: (() => void) | null = null;
	private statusEl!: HTMLElement;
	private listsEl!: HTMLElement;
	private noticeEl!: HTMLElement;
	private cardsEl!: HTMLElement;
	private tableEl!: HTMLTableElement;
	private emptyEl!: HTMLElement;
	private logEl!: HTMLDetailsElement;
	private logOpen = false;
	private pressedAt = 0; // 手指／滑鼠按下去的時間：按著的時候先不重畫（不然剛好重畫，那一下點擊會落空）
	private dirty = false;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: StockViewPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}
	getDisplayText(): string {
		return "StockView";
	}
	getIcon(): string {
		return "line-chart";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("sv-root");
		root.addEventListener("click", () => unlockAudio());
		root.addEventListener("pointerdown", () => (this.pressedAt = Date.now()));
		const release = () => {
			if (!this.pressedAt) return;
			this.pressedAt = 0;
			// 等這一下的 click 事件先跑完再補畫
			if (this.dirty) window.setTimeout(() => this.render(), 80);
		};
		root.addEventListener("pointerup", release);
		root.addEventListener("pointercancel", release);
		root.addEventListener("pointerleave", release);

		const head = root.createDiv("sv-head");
		head.createEl("h2", { text: "StockView" });
		this.statusEl = head.createDiv("sv-status");
		const btns = head.createDiv("sv-btns");
		const btn = (icon: string, label: string, fn: () => void, cta = false) => {
			const b = btns.createEl("button", { cls: cta ? "mod-cta" : "", attr: { "aria-label": label } });
			const i = b.createSpan("sv-btn-icon");
			setIcon(i, icon);
			b.createSpan({ text: label, cls: "sv-btn-text" });
			b.onclick = fn;
			return b;
		};
		btn("plus", "新增股票", () => this.plugin.openHoldingModal({ list: this.plugin.defaultAddList() }), true);
		btn("globe", "市場", () => void this.plugin.openMarkets());
		btn("refresh-cw", "重新整理", () => {
			this.plugin.feed.refreshNow();
			void this.plugin.sync.now(15_000); // 順便拉別台裝置新增的股票
		});
		btn("settings", "設定", () => this.plugin.openSettings());

		this.listsEl = root.createDiv("sv-lists");
		this.noticeEl = root.createDiv("sv-notices");
		this.cardsEl = root.createDiv("sv-cards");
		this.emptyEl = root.createDiv("sv-empty");
		const wrap = root.createDiv("sv-table-wrap");
		this.tableEl = wrap.createEl("table", { cls: "sv-table" });
		this.logEl = root.createEl("details", { cls: "sv-log" });
		this.logEl.addEventListener("toggle", () => (this.logOpen = this.logEl.open));
		root.createDiv({ cls: "sv-foot", text: "報價：Yahoo Finance（免費，可能有延遲）· 評級：Finnhub（分析師共識，僅供參考）· 不構成投資建議" });

		this.unsub = this.plugin.feed.subscribe(() => this.render());
		this.render();
		this.plugin.feed.kick();
		void this.plugin.sync.now(60_000);
	}

	async onClose(): Promise<void> {
		this.unsub?.();
		this.unsub = null;
	}

	render(): void {
		if (!this.tableEl) return;
		// 正按著（3 秒內）：等放開再畫。超過 3 秒就照常畫，避免沒收到「放開」時畫面卡住不更新
		if (this.pressedAt && Date.now() - this.pressedAt < 3000) {
			this.dirty = true;
			return;
		}
		this.dirty = false;
		const p = this.plugin;
		const s = p.settings;
		const feed = p.feed;
		this.contentEl.dataset.color = s.colorStyle;
		const sel = p.selectedList();
		const rows = feed.rows(sel);
		this.renderLists(sel);

		// 狀態列
		this.statusEl.empty();
		// 市場狀態：有任何一檔在盤中就顯示盤中，其次盤前／盤後
		const order: Session[] = ["regular", "pre", "post", "closed"];
		const sessions = new Set(feed.rows().map((r) => r.q?.session).filter((x): x is Session => !!x));
		const ses = order.find((x) => sessions.has(x));
		if (ses) this.statusEl.createSpan({ cls: `sv-session sv-s-${ses}`, text: SESSION_LABEL[ses] });
		this.statusEl.createSpan({ text: feed.lastRound ? `更新 ${F.clock(feed.lastRound)}` : "讀取中…" });
		if (feed.lastRound) this.statusEl.createSpan({ cls: "sv-muted", text: `每 ${Math.round(feed.intervalMs() / 1000)} 秒` });

		// 提示
		this.noticeEl.empty();
		const note = (text: string, cls = "") => this.noticeEl.createDiv({ cls: `sv-notice ${cls}`, text });
		if (feed.status) note(feed.status, "sv-warn");
		const t = totals(rows, s.base, feed.fx);
		if (t.fxMissing) note("匯率還沒抓到，暫用 1 美元＝32 台幣", "sv-warn");
		if (s.showRatings && rows.some((r) => isUsTicker(r.h.ticker))) {
			if (!p.ratings.key()) note("想看華爾街評級：到設定填 Finnhub 免費金鑰（不填也能用其他功能）");
			else if (p.ratings.lastError) note(`華爾街評級：${p.ratings.lastError}`, "sv-warn");
		}

		this.renderCards(t, rows);
		this.renderTable(rows);
		this.renderLog();
	}

	/** 清單分頁：全部（有兩個以上清單時）、各清單（股票數）、＋ 新清單、⋯（改名／刪除目前清單）。 */
	private renderLists(sel: string): void {
		const p = this.plugin;
		const feed = p.feed;
		const vis = feed.visibleLists();
		this.listsEl.empty();
		const tab = (key: string, label: string, count: number | null) => {
			const b = this.listsEl.createEl("button", { cls: `sv-list-tab${key === sel ? " is-active" : ""}` });
			b.createSpan({ text: label });
			if (count !== null) b.createSpan({ cls: "sv-list-count", text: String(count) });
			b.onclick = () => p.selectList(key);
		};
		if (vis.length > 1) tab(ALL_LISTS, "全部", new Set(feed.holdings.map((h) => h.ticker)).size);
		for (const l of vis) tab(l, listLabel(l), feed.holdings.filter((h) => h.list === l).length);
		const add = this.listsEl.createEl("button", { cls: "sv-list-add", text: "＋ 新清單", attr: { "aria-label": "新增清單" } });
		add.onclick = () => p.openListModal();
		if (sel !== ALL_LISTS && sel !== MAIN_LIST) {
			const more = this.listsEl.createEl("button", { cls: "sv-list-more", attr: { "aria-label": "清單選項" } });
			setIcon(more, "more-horizontal");
			more.onclick = (e) => {
				const m = new Menu();
				m.addItem((i) => i.setTitle(`「${sel}」改名…`).setIcon("pencil").onClick(() => p.openListModal(sel)));
				m.addItem((i) => i.setTitle(`刪除清單「${sel}」…`).setIcon("trash").onClick(() => p.openDeleteListModal(sel)));
				m.showAtMouseEvent(e);
			};
		}
	}

	private renderCards(t: ReturnType<typeof totals>, rows: Row[]): void {
		const base = this.plugin.settings.base;
		this.cardsEl.empty();
		const held = rows.filter((r) => r.h.shares !== null);
		this.cardsEl.toggle(held.length > 0);
		if (!held.length) return;
		const card = (label: string, value: string, sub?: string, d?: "up" | "down" | "flat") => {
			const c = this.cardsEl.createDiv("sv-card");
			c.createDiv({ cls: "sv-card-label", text: label });
			c.createDiv({ cls: `sv-card-value ${d ? "sv-" + d : ""}`, text: value });
			if (sub) c.createDiv({ cls: `sv-card-sub ${d ? "sv-" + d : ""}`, text: sub });
		};
		card("總市值", F.money(t.value, base), t.missing ? `${t.missing} 檔還沒有報價` : `${held.length} 檔持股`);
		card("總損益", F.money(t.pl, base, true), F.pct(t.plPct), F.dir(t.pl));
		card("今日損益", F.money(t.day, base, true), F.pct(t.dayPct), F.dir(t.day));
		card("總成本", F.money(t.cost, base), t.needsFx && this.plugin.feed.fx ? `匯率 ${this.plugin.feed.fx.toFixed(2)}` : undefined);
	}

	private sortState(): { key: SortKey; desc: boolean } {
		const v = this.app.loadLocalStorage(LS_SORT) as { key?: SortKey; desc?: boolean } | null;
		return { key: v?.key ?? "value", desc: v?.desc ?? true };
	}

	private sorted(rows: Row[]): Row[] {
		const { key, desc } = this.sortState();
		const { base } = this.plugin.settings;
		const fx = this.plugin.feed.fx;
		const val = (r: Row): number | string | null => {
			switch (key) {
				case "ticker":
					return r.h.ticker;
				case "price":
					return r.q?.price ?? null;
				case "day":
					return r.dayPct;
				case "value":
					return r.value === null ? null : toBase(r.value, r.cur, base, fx);
				case "pl":
					return r.plPct;
				case "range":
					return rangeState(r.alarmPrice, r.h.low, r.h.high).pos;
				case "rating":
					return ratingInfo(this.plugin.ratings.get(r.h.ticker))?.score ?? null;
			}
		};
		return [...rows].sort((a, b) => {
			// 持股在前、觀察名單在後
			const ha = a.h.shares !== null ? 0 : 1;
			const hb = b.h.shares !== null ? 0 : 1;
			if (ha !== hb && key !== "ticker") return ha - hb;
			const va = val(a);
			const vb = val(b);
			if (va === null && vb === null) return a.h.ticker < b.h.ticker ? -1 : 1;
			if (va === null) return 1;
			if (vb === null) return -1;
			const c = va < vb ? -1 : va > vb ? 1 : 0;
			return desc ? -c : c;
		});
	}

	private renderTable(rows: Row[]): void {
		const p = this.plugin;
		this.emptyEl.empty();
		this.emptyEl.toggle(rows.length === 0);
		this.tableEl.toggle(rows.length > 0);
		if (!rows.length) {
			const sel = p.selectedList();
			this.emptyEl.createEl("p", {
				text:
					p.feed.holdings.length && sel !== ALL_LISTS
						? `「${listLabel(sel)}」還沒有股票。`
						: `還沒有股票。按「新增股票」，或在「${p.settings.folder}」資料夾放筆記（frontmatter 寫 ticker、shares、cost、low、fair、high；子資料夾是不同的清單）。`,
			});
			const b = this.emptyEl.createEl("button", { cls: "mod-cta", text: "新增股票" });
			b.onclick = () => p.openHoldingModal({ list: p.defaultAddList() });
			return;
		}
		this.tableEl.empty();
		const { key, desc } = this.sortState();
		const tr = this.tableEl.createEl("thead").createEl("tr");
		for (const c of COLS) {
			const th = tr.createEl("th", { cls: c.cls ?? "" });
			th.setText(c.label + (c.key === key ? (desc ? " ▼" : " ▲") : ""));
			if (c.key) {
				th.addClass("sv-sortable");
				th.onclick = () => {
					const cur = this.sortState();
					this.app.saveLocalStorage(LS_SORT, { key: c.key, desc: cur.key === c.key ? !cur.desc : c.key !== "ticker" });
					this.render();
				};
			}
		}
		const body = this.tableEl.createEl("tbody");
		for (const r of this.sorted(rows)) this.renderRow(body, r);
	}

	private renderRow(body: HTMLElement, r: Row): void {
		const p = this.plugin;
		const q = r.q;
		const tr = body.createEl("tr", { cls: r.h.shares === null ? "sv-watch" : "" });

		// 股票
		const name = tr.createEl("td", { cls: "sv-c-name" });
		const tk = name.createEl("button", { cls: "sv-ticker", text: r.h.ticker });
		tk.onclick = (e) => this.rowMenu(e, r);
		if (q?.name) name.createDiv({ cls: "sv-name", text: q.name });
		const err = p.feed.errors.get(r.h.ticker);
		if (err) name.createDiv({ cls: "sv-err", text: err });
		if (r.h.shares === null) name.createDiv({ cls: "sv-tag", text: "觀察" });
		// 「全部」裡標出在哪些清單
		if (p.selectedList() === ALL_LISTS && p.feed.visibleLists().length > 1) name.createDiv({ cls: "sv-in-lists", text: r.h.lists.map(listLabel).join("、") });

		// 現價
		tr.createEl("td", { cls: "sv-num sv-price", text: F.price(q?.price ?? null, r.cur) });

		// 今日漲跌
		const day = tr.createEl("td", { cls: `sv-num sv-${F.dir(r.dayChg)}` });
		day.createDiv({ text: F.signedNum(r.dayChg) });
		day.createDiv({ cls: "sv-sub", text: F.pct(r.dayPct) });

		// 盤前／盤後
		const ext = tr.createEl("td", { cls: "sv-num" });
		if (q?.ext && q.price) {
			const chg = ((q.ext.price - q.price) / q.price) * 100;
			ext.createDiv({ cls: "sv-sub", text: q.ext.kind === "pre" ? "盤前" : "盤後" });
			ext.createDiv({ text: F.price(q.ext.price, r.cur) });
			ext.createDiv({ cls: `sv-sub sv-${F.dir(chg)}`, text: F.pct(chg) });
		} else ext.setText("—");

		// 股數／成本
		const sc = tr.createEl("td", { cls: "sv-num" });
		sc.createDiv({ text: F.shares(r.h.shares) });
		if (r.h.cost !== null) sc.createDiv({ cls: "sv-sub", text: "@ " + F.price(r.h.cost, r.cur) });

		// 市值
		tr.createEl("td", { cls: "sv-num", text: F.money(r.value, r.cur) });

		// 未實現損益
		const pl = tr.createEl("td", { cls: `sv-num sv-${F.dir(r.pl)}` });
		pl.createDiv({ text: F.money(r.pl, r.cur, true) });
		pl.createDiv({ cls: "sv-sub", text: F.pct(r.plPct) });

		// 估值區間
		this.renderRange(tr.createEl("td", { cls: "sv-c-range" }), r);

		// 華爾街評級
		const rt = tr.createEl("td", { cls: "sv-c-rating" });
		if (!isUsTicker(r.h.ticker) || !p.settings.showRatings) rt.setText("—");
		else {
			const rating = p.ratings.get(r.h.ticker);
			const info = ratingInfo(rating);
			if (info && rating) {
				rt.createSpan({ cls: `sv-rating sv-r-${info.cls}`, text: info.label });
				rt.createDiv({ cls: "sv-sub", text: `${info.total} 位分析師` });
				rt.title = `強力買進 ${rating.strongBuy}、買進 ${rating.buy}、持有 ${rating.hold}、賣出 ${rating.sell}、強力賣出 ${rating.strongSell}（${rating.period}）`;
			} else rt.createSpan({ cls: "sv-muted", text: !p.ratings.key() ? "—" : p.ratings.none(r.h.ticker) ? "沒有資料" : "讀取中…" });
		}
	}

	private renderRange(td: HTMLElement, r: Row): void {
		const { low, high, fair } = r.h;
		if (low === null && high === null && fair === null) {
			td.createSpan({ cls: "sv-muted", text: "—" });
			return;
		}
		const st = rangeState(r.alarmPrice, low, high);
		const w = this.plugin.alarms.waiting(r.h.lists, r.h.ticker);
		const box = td.createDiv("sv-range");
		if (low !== null || high !== null) {
			const bar = box.createDiv("sv-bar");
			const fp = fairPos(fair, low, high);
			if (fp !== null) {
				const f = bar.createDiv("sv-fair-tick");
				f.style.left = `${fp}%`;
				f.title = `合理價位 ${F.price(fair, r.cur)}`;
			}
			if (st.pos !== null) {
				const m = bar.createDiv("sv-marker");
				m.style.left = `${st.pos}%`;
			}
			const lab = box.createDiv("sv-range-labels");
			lab.createSpan({ text: low === null ? "—" : F.price(low, r.cur) });
			lab.createSpan({ text: high === null ? "—" : F.price(high, r.cur) });
		}
		// 合理價位：現價比它貴或便宜多少
		if (fair !== null) {
			const d = vsFair(r.alarmPrice, fair);
			const rel = d === null ? "" : Math.abs(d) < 0.5 ? "，接近合理價" : d > 0 ? `，現價高 ${d.toFixed(1)}%` : `，現價低 ${Math.abs(d).toFixed(1)}%`;
			box.createDiv({ cls: "sv-fair", text: `合理 ${F.price(fair, r.cur)}${rel}` });
		}
		const badge =
			st.state === "above" ? ["突破上限", "sv-b-above"] : st.state === "below" ? ["跌破下限", "sv-b-below"] : st.state === "inside" ? [st.pos !== null ? `區間內 ${Math.round(st.pos)}%` : "區間內", "sv-b-inside"] : null;
		if (badge) {
			const b = box.createSpan({ cls: `sv-badge ${badge[1]}`, text: badge[0] });
			if (w.high || w.low) b.setText(badge[0] + " 🔕");
			if (w.high || w.low) b.title = "已提醒過；價格回到界線內再提醒";
		}
	}

	/** 點代號的選單。「全部」裡同一檔在好幾個清單時，每個清單各一項「編輯」。 */
	private rowMenu(e: MouseEvent, r: Row): void {
		const p = this.plugin;
		const feed = p.feed;
		const perList = r.h.lists
			.map((l) => feed.holdings.find((h) => h.list === l && h.ticker === r.h.ticker))
			.filter((h): h is Holding => !!h);
		const vis = feed.visibleLists();
		const many = vis.length > 1;
		const m = new Menu();
		if (perList.length > 1) {
			for (const h of perList) m.addItem((i) => i.setTitle(`編輯（${listLabel(h.list)}）…`).setIcon("pencil").onClick(() => p.openHoldingModal({ existing: h })));
			for (const h of perList) m.addItem((i) => i.setTitle(`打開筆記（${listLabel(h.list)}）`).setIcon("file-text").onClick(() => p.openNote(h.paths[0])));
		} else {
			const h = perList[0] ?? r.h;
			m.addItem((i) => i.setTitle("編輯…").setIcon("pencil").onClick(() => p.openHoldingModal({ existing: h })));
			m.addItem((i) => i.setTitle(h.paths.length > 1 ? `打開筆記（共 ${h.paths.length} 篇）` : "打開筆記").setIcon("file-text").onClick(() => p.openNote(h.paths[0])));
			if (many) m.addItem((i) => i.setTitle("移到其他清單…").setIcon("folder-input").onClick(() => p.openMoveModal(h)));
		}
		const has = new Set(feed.holdings.filter((h) => h.ticker === r.h.ticker).map((h) => h.list));
		const others = vis.filter((l) => !has.has(l));
		if (others.length)
			m.addItem((i) =>
				i
					.setTitle("加到其他清單…")
					.setIcon("copy-plus")
					.onClick(() => p.openHoldingModal({ list: others[0], prefill: { ticker: r.h.ticker, low: r.h.low, high: r.h.high, fair: r.h.fair } })),
			);
		if (perList.length <= 1) {
			const h = perList[0] ?? r.h;
			m.addItem((i) => i.setTitle(many ? `從「${listLabel(h.list)}」刪除…` : "刪除…").setIcon("trash").onClick(() => p.openDeleteModal(h)));
		}
		m.showAtMouseEvent(e);
	}

	private renderLog(): void {
		const log = this.plugin.alarms.log;
		this.logEl.empty();
		this.logEl.toggle(log.length > 0);
		if (!log.length) return;
		this.logEl.open = this.logOpen;
		this.logEl.createEl("summary", { text: `警示紀錄（${log.length}）` });
		const ul = this.logEl.createEl("ul");
		for (const e of log) ul.createEl("li", { cls: e.kind === "high" ? "sv-up" : "sv-down", text: `${F.dateTime(e.at)}　${alarmText(e)}` });
		const clr = this.logEl.createEl("button", { text: "清除紀錄" });
		clr.onclick = () => {
			this.plugin.alarms.clearLog();
			this.render();
		};
	}
}
