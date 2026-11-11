import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/config";
import { MarketData, RangeDef, Series } from "../src/markets";
import { LS_MARKET_RANGE, LS_MARKET_TAB, MarketsView } from "../src/marketview";
import { LS_TXF_POINTS } from "../src/taifex";
import { makeApp } from "./helpers/app";

function series(symbol: string, last: number, base: number): Series {
	return { symbol, points: [{ t: 0, v: base }, { t: 60, v: (base + last) / 2 }, { t: 120, v: last }], base, last, gmtoffset: 0, session: "closed", domain: null };
}

async function mount(fetcher: (s: string, r: RangeDef) => Promise<Series>, taifex?: (m: "0" | "1") => Promise<any>, now?: () => number) {
	const { app, ls } = makeApp();
	const plugin: any = { app, settings: { ...DEFAULT_SETTINGS }, opened: [] as string[], openDashboard: async () => plugin.opened.push("dash") };
	const calls: string[] = [];
	const data = new MarketData(async (s, r) => (calls.push(`${s}@${r.id}`), fetcher(s, r)));
	const view = new MarketsView({ app } as never, plugin, data, taifex ?? (async () => { throw new Error("沒測"); }), now);
	(view as any).registerInterval = () => 0;
	await view.onOpen();
	// 測試裡不要真的計時（失敗時會讓測試卡住）；需要時直接呼叫 load()
	window.clearInterval((view as any).timer);
	return { view, el: view.contentEl, ls, calls, plugin };
}

const text = (el: Element) => el.textContent ?? "";

test("預設美股、1日：四個指數卡片，有數值、漲跌與走勢圖", async () => {
	const { view, el, calls } = await mount(async (s) => series(s, 110, 100));
	assert.deepEqual(
		[...el.querySelectorAll(".sv-market-tabs .sv-list-tab")].map(text),
		["美股", "台股", "日股", "陸股", "韓股", "歐股", "匯率"],
	);
	assert.match(text(el.querySelector(".sv-market-tabs .is-active")!), /美股/);
	assert.match(text(el.querySelector(".sv-ranges .is-active")!), /1日/);
	assert.deepEqual(calls, ["^GSPC@1d", "^DJI@1d", "^IXIC@1d", "^SOX@1d"]);
	const cards = [...el.querySelectorAll(".sv-mcard")];
	assert.equal(cards.length, 4);
	assert.match(text(cards[0]), /S&P 500\^GSPC收盤110\.00\+10\.00（\+10\.00%）比昨收/);
	assert.ok(cards[0].querySelector(".sv-chart.sv-up svg"));
	await view.onClose();
});

test("切換市場和期間：只抓那個市場；記住選擇", async () => {
	const { view, el, ls, calls } = await mount(async (s) => series(s, 90, 100));
	calls.length = 0;
	const tw = [...el.querySelectorAll(".sv-market-tabs .sv-list-tab")].find((b) => text(b) === "台股") as HTMLButtonElement;
	tw.click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(ls.get(LS_MARKET_TAB), "tw");
	assert.deepEqual(calls, ["^TWII@1d", "TSM@1d", "EWT@1d"]);
	assert.equal(el.querySelectorAll(".sv-mcard").length, 4, "加權、台指期、台積電 ADR、MSCI 台灣");
	assert.ok(el.querySelector(".sv-chart.sv-down"), "下跌的顏色");
	const y1 = [...el.querySelectorAll(".sv-range-btn")].find((b) => text(b) === "1年") as HTMLButtonElement;
	y1.click();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(ls.get(LS_MARKET_RANGE), "1y");
	assert.deepEqual(calls.slice(3), ["^TWII@1y", "TSM@1y", "EWT@1y"]);
	assert.match(text(el.querySelector(".sv-mcard")!), /1年來/);
	await view.onClose();
});

test("匯率頁：顯示幾台幣換一單位外幣；拿不到的卡片顯示原因，其他照常", async () => {
	const { view, el } = await mount(async (s) => {
		if (s === "KRWTWD=X" || s === "KRW=X") throw Object.assign(new Error("Yahoo 沒有這個代號"), { status: 404 });
		return series(s, s === "TWD=X" ? 32.5 : 0.2, s === "TWD=X" ? 32 : 0.2);
	});
	(el.querySelectorAll(".sv-market-tabs .sv-list-tab")[6] as HTMLButtonElement).click();
	await new Promise((r) => setTimeout(r, 0));
	const cards = [...el.querySelectorAll(".sv-mcard")];
	assert.equal(cards.length, 8);
	assert.deepEqual(
		cards.map((c) => text(c.querySelector(".sv-mcard-name")!).replace(/[A-Z]+=X$/, "")),
		["美元／台幣", "日圓／台幣", "人民幣／台幣", "韓元／台幣", "歐元／台幣", "英鎊／台幣", "瑞士法郎／台幣", "澳幣／台幣"],
	);
	assert.match(text(cards[0]), /美元／台幣TWD=X32\.500 台幣／1 美元\+0\.500（\+1\.56%）/);
	assert.match(text(cards[1]), /20\.000 台幣／100 日圓/, "0.2 × 100");
	assert.match(text(cards[3]), /韓元／台幣拿不到資料：Yahoo 沒有這個代號/);
	assert.ok(!text(cards[0]).includes("收盤"), "匯率不顯示開收盤");
	await view.onClose();
});

test("台股頁的台指期：夜盤報價、比參考價、最高最低、記錄的走勢；期交所拿不到時只有這張顯示原因", async () => {
	const night = Date.UTC(2026, 10, 6, 14) / 1000; // 台北 11/6（週五）22:00
	let price = 23456;
	let tick = 0;
	let fail = false;
	const { view, el, ls } = await mount(
		async (s) => series(s, 110, 100),
		async (m) => {
			if (fail) throw new Error("期交所 HTTP 520");
			return { name: "臺指期11", last: price, ref: 23400, high: 23500, low: 23350, time: `22:00:${String(tick++).padStart(2, "0")}`, market: m };
		},
		() => night,
	);
	ls.set(LS_MARKET_TAB, "tw");
	(el.querySelectorAll(".sv-market-tabs .sv-list-tab")[1] as HTMLButtonElement).click();
	await new Promise((r) => setTimeout(r, 0));
	const card = () => [...el.querySelectorAll(".sv-mcard")].find((c) => (c as HTMLElement).dataset.symbol === "TXF")!;
	assert.match(text(card()), /台指期（近月）臺指期11夜盤交易中23,456\.00\+56（\+0\.24%）夜盤・比參考價最高 23,500\.00　最低 23,350\.00　成交 22:00:00/);
	assert.match(text(card()), /打開這頁後開始記錄走勢/);
	price = 23470;
	await (view as any).load(false, true);
	assert.ok(card().querySelector(".sv-chart svg"), "有兩點就畫圖");
	fail = true;
	await (view as any).load(false, true);
	assert.match(text(card()), /拿不到資料：期交所 HTTP 520/);
	assert.match(text(el), /加權指數/, "其他卡片照常");
	await view.onClose();
});

test("自動更新：看不到這一頁時不抓；台指期交易中每 30 秒、收盤中每 5 分鐘；國定假日標休市", async () => {
	let now = Date.UTC(2026, 10, 6, 14) / 1000; // 台北週五 22:00（夜盤）
	let txf = 0;
	let time = "22:00:00";
	const { view, el, ls, calls } = await mount(
		async (s) => series(s, 110, 100),
		async (m) => (txf++, { name: "臺指期11", last: 23456, ref: 23400, high: null, low: null, time, market: m }),
		() => now,
	);
	ls.set(LS_MARKET_TAB, "tw");
	ls.set(LS_MARKET_RANGE, "1y");
	await view.load();
	const tapeKeyOf = (l: Map<string, unknown>) => (l.get(LS_TXF_POINTS) as { key?: string } | undefined)?.key;
	const fri = tapeKeyOf(ls);
	assert.ok(fri, "交易中有記錄走勢");
	const flush = () => new Promise((r) => setTimeout(r, 0));
	const base = { txf, yahoo: calls.length };
	(view as any).tick(); // 第 1 次：只更新台指期
	await flush();
	assert.equal(txf, base.txf + 1);
	assert.equal(calls.length, base.yahoo, "1年走勢不用每分鐘重抓");
	// 看不到（切到別的分頁）
	view.contentEl.style.display = "none";
	(view as any).tick();
	(view as any).tick();
	await flush();
	assert.equal(txf, base.txf + 1, "看不到時不抓");
	view.contentEl.style.display = "";
	// 收盤中（週六中午）：每 10 次（5 分鐘）才抓一次
	now = Date.UTC(2026, 10, 7, 4) / 1000;
	const before = txf;
	for (let i = 0; i < 10; i++) (view as any).tick();
	await flush();
	assert.equal(txf, before + 1);
	// 平日日盤時間、最後成交卻是清晨 → 休市
	now = Date.UTC(2026, 10, 9, 2) / 1000; // 台北週一 10:00
	time = "04:59:58";
	await view.load();
	const card = [...el.querySelectorAll(".sv-mcard")].find((c) => (c as HTMLElement).dataset.symbol === "TXF")!;
	assert.match(text(card.querySelector(".sv-session")!), /休市/);
	assert.equal(tapeKeyOf(ls), fri, "休市時不記錄，上一盤（週五夜盤）的圖留著");
	await view.onClose();
});
