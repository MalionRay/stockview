import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Alarms } from "../src/alarms";
import { DEFAULT_SETTINGS } from "../src/config";
import { Feed } from "../src/feed";
import { Ratings, SECRET_FINNHUB } from "../src/ratings";
import { DashboardView, LS_SORT } from "../src/view";
import StockViewPlugin from "../src/main";
import { LS_LIST } from "../src/config";
import { makeApp } from "./helpers/app";
import { DAY, chart, note } from "./fixtures";
const ob = require("obsidian");

async function mount(files: [string, string][], opts: { key?: boolean; settings?: Partial<typeof DEFAULT_SETTINGS> } = {}) {
	const { app, secrets, ls } = makeApp(new Map(files));
	if (opts.key) secrets.set(SECRET_FINNHUB, "k");
	const settings = { ...DEFAULT_SETTINGS, ...opts.settings };
	const alarms = new Alarms(app);
	const plugin: any = { app, settings, alarms, opened: [] as string[] };
	plugin.ratings = new Ratings(app, () => plugin.feed.emit());
	plugin.feed = new Feed({ app, settings, alarms, ratings: plugin.ratings, viewOpen: () => true, onAlarm: () => undefined });
	for (const k of ["selectedList", "selectList", "defaultAddList"]) plugin[k] = (StockViewPlugin.prototype as any)[k].bind(plugin);
	plugin.openHoldingModal = (o: { existing?: { ticker: string; list: string }; list?: string; prefill?: { ticker?: string } } = {}) =>
		plugin.opened.push(o.existing ? `modal:${o.existing.list}/${o.existing.ticker}` : `modal:new@${o.list ?? ""}${o.prefill?.ticker ? ":" + o.prefill.ticker : ""}`);
	plugin.openListModal = (r?: string) => plugin.opened.push("list:" + (r ?? "new"));
	plugin.openDeleteListModal = (l: string) => plugin.opened.push("dellist:" + l);
	plugin.openMoveModal = (h: { ticker: string }) => plugin.opened.push("move:" + h.ticker);
	plugin.openDeleteModal = (h: { ticker: string }) => plugin.opened.push("delete:" + h.ticker);
	plugin.openNote = (p: string) => plugin.opened.push("note:" + p);
	plugin.openSettings = () => plugin.opened.push("settings");
	plugin.syncCalls = [] as number[];
	plugin.sync = { now: async (gap: number) => (plugin.syncCalls.push(gap), true), soon: () => undefined };
	const view = new DashboardView({ app } as never, plugin);
	await view.onOpen();
	return { view, plugin, el: view.contentEl, ls };
}

const text = (el: Element) => el.textContent ?? "";

test("沒有股票：顯示說明和新增按鈕", async () => {
	const { el, plugin } = await mount([]);
	assert.match(text(el), /還沒有股票/);
	(el.querySelector(".sv-empty button") as HTMLButtonElement).click();
	assert.deepEqual(plugin.opened, ["modal:new@"]);
	assert.deepEqual(plugin.syncCalls, [60_000], "打開儀表板就同步一次（拉別台裝置的改動）");
	const refresh = [...el.querySelectorAll(".sv-btns button")].find((b) => b.getAttribute("aria-label") === "重新整理") as HTMLButtonElement;
	refresh.click();
	assert.deepEqual(plugin.syncCalls, [60_000, 15_000]);
});

test("持股：總計卡片、表格、盤後價、估值區間、評級", async () => {
	const now = Date.now() / 1000;
	// 讓「現在」落在盤後時段
	const period = { pre: { start: now - 30000, end: now - 20000 }, regular: { start: now - 20000, end: now - 100 }, post: { start: now - 100, end: now + 10000 } };
	ob.__setRequestHandler(async (r: { url: string }) => {
		if (r.url.includes("finnhub")) return { status: 200, json: [{ period: "2026-11-01", strongBuy: 10, buy: 20, hold: 5, sell: 0, strongSell: 0 }] };
		if (r.url.includes("/NVDA?")) return { status: 200, json: chart({ price: 210, prev: 200, name: "Example Chips", period, bars: [[now - 200, 210], [now - 50, 212]] }) };
		return { status: 200, json: chart({ price: 50, prev: 50, period: DAY }) };
	});
	const { el, plugin } = await mount(
		[
			["Portfolio/NVDA.md", note({ ticker: "NVDA", shares: 10, cost: 100, low: 150, high: 220 })],
			["Portfolio/MSFT.md", note({ ticker: "MSFT", shares: "", cost: "" })],
		],
		{ key: true },
	);
	await plugin.feed.round();
	await new Promise((r) => setTimeout(r, 1300)); // 評級在背景依序抓（每檔間隔 1.1 秒）
	plugin.feed.emit();
	const cards = [...el.querySelectorAll(".sv-card")].map(text);
	assert.match(cards[0], /總市值\$2,100\.00/);
	assert.match(cards[1], /總損益\+\$1,100\.00\+110\.00%/);
	assert.match(cards[2], /今日損益\+\$100\.00/);
	const rows = [...el.querySelectorAll("tbody tr")];
	assert.equal(rows.length, 2);
	assert.match(text(rows[0]), /^NVDA/, "持股在前");
	assert.match(text(rows[1]), /觀察/);
	assert.match(text(rows[0]), /盤後\$212\.00\+0\.95%/);
	assert.match(text(rows[0]), /區間內 89%/, "盤後價 212 在 150～220 的 89%");
	assert.match(text(rows[0]), /買進35 位分析師/);
	assert.match(text(el.querySelector(".sv-status")!), /盤後/);
	assert.ok(el.querySelector(".sv-up"), "上漲有顏色");
});

test("點代號出現選單；點表頭換排序", async () => {
	ob.__setRequestHandler(async (r: { url: string }) => ({ status: 200, json: chart({ price: r.url.includes("/AAA?") ? 10 : 20 }) }));
	const { el, plugin, ls } = await mount([
		["Portfolio/AAA.md", note({ ticker: "AAA", shares: 100, cost: 1 })],
		["Portfolio/BBB.md", note({ ticker: "BBB", shares: 1, cost: 1 })],
	]);
	await plugin.feed.round();
	const order = () => [...el.querySelectorAll("tbody .sv-ticker")].map(text);
	assert.deepEqual(order(), ["AAA", "BBB"], "預設依市值由大到小");
	(el.querySelector("tbody .sv-ticker") as HTMLButtonElement).click();
	const menu = (globalThis as any).__lastMenu;
	assert.deepEqual(
		menu.items.map((i: { title: string }) => i.title),
		["編輯…", "打開筆記", "刪除…"],
	);
	menu.items[2].cb();
	assert.deepEqual(plugin.opened, ["delete:AAA"]);
	const priceTh = [...el.querySelectorAll("th")].find((th) => text(th).startsWith("現價")) as HTMLElement;
	priceTh.click();
	assert.deepEqual(ls.get(LS_SORT), { key: "price", desc: true });
	assert.deepEqual(order(), ["BBB", "AAA"]);
	(([...el.querySelectorAll("th")].find((th) => text(th).startsWith("現價")) as HTMLElement)).click();
	assert.deepEqual(order(), ["AAA", "BBB"]);
});

test("沒有金鑰：提示可以填 Finnhub；警示紀錄顯示與清除", async () => {
	ob.__setRequestHandler(async () => ({ status: 200, json: chart({ price: 300 }) }));
	const { el, plugin } = await mount([["Portfolio/AAA.md", note({ ticker: "AAA", shares: 1, high: 250 })]]);
	await plugin.feed.round();
	assert.match(text(el.querySelector(".sv-notices")!), /Finnhub/);
	assert.match(text(el.querySelector(".sv-log")!), /警示紀錄（1）.*AAA 突破上限 250/);
	assert.match(text(el), /突破上限 🔕/);
	(el.querySelector(".sv-log button") as HTMLButtonElement).click();
	assert.equal((el.querySelector(".sv-log") as HTMLElement).style.display, "none");
});

test("多個清單：分頁、切換、全部合併、新增到目前清單、清單選單", async () => {
	ob.__setRequestHandler(async () => ({ status: 200, json: chart({ price: 100, prev: 100 }) }));
	const { el, plugin, ls } = await mount([
		["Portfolio/帳戶A/NVDA.md", note({ ticker: "NVDA", shares: 10, cost: 50 })],
		["Portfolio/帳戶B/NVDA.md", note({ ticker: "NVDA", shares: 5, cost: 80 })],
		["Portfolio/帳戶B/AMD.md", note({ ticker: "AMD", shares: 1, cost: 100 })],
	]);
	await plugin.feed.round();
	const tabs = () => [...el.querySelectorAll(".sv-list-tab")].map(text);
	assert.deepEqual(tabs(), ["全部2", "帳戶A1", "帳戶B2"], "主清單沒有股票就不顯示");
	assert.match(text(el.querySelector(".sv-list-tab.is-active")!), /^全部/);
	const nvda = () => [...el.querySelectorAll("tbody tr")].find((tr) => text(tr).startsWith("NVDA"))!;
	assert.match(text(nvda()), /帳戶A、帳戶B/, "全部裡標出在哪些清單");
	assert.match(text(el.querySelector(".sv-card")!), /\$1,600\.00/, "全部：NVDA 15 股＋AMD 1 股");
	assert.equal(el.querySelector(".sv-list-more"), null, "全部沒有改名／刪除");

	(el.querySelector("tbody .sv-ticker") as HTMLButtonElement).click();
	let menu = (globalThis as any).__lastMenu;
	assert.deepEqual(
		menu.items.map((i: { title: string }) => i.title),
		["編輯（帳戶A）…", "編輯（帳戶B）…", "打開筆記（帳戶A）", "打開筆記（帳戶B）"],
	);

	(el.querySelectorAll(".sv-list-tab")[2] as HTMLButtonElement).click();
	assert.equal(ls.get(LS_LIST), "帳戶B");
	assert.equal(el.querySelectorAll("tbody tr").length, 2);
	assert.match(text(el.querySelector(".sv-card")!), /\$600\.00/);
	(el.querySelector(".sv-btns .mod-cta") as HTMLButtonElement).click();
	assert.equal(plugin.opened.at(-1), "modal:new@帳戶B", "新增到目前的清單");

	const amd = [...el.querySelectorAll("tbody .sv-ticker")].find((b) => text(b) === "AMD") as HTMLButtonElement;
	amd.click();
	menu = (globalThis as any).__lastMenu;
	assert.deepEqual(
		menu.items.map((i: { title: string }) => i.title),
		["編輯…", "打開筆記", "移到其他清單…", "加到其他清單…", "從「帳戶B」刪除…"],
	);
	menu.items[3].cb();
	assert.equal(plugin.opened.at(-1), "modal:new@帳戶A:AMD");

	(el.querySelector(".sv-list-more") as HTMLButtonElement).click();
	menu = (globalThis as any).__lastMenu;
	menu.items[1].cb();
	assert.equal(plugin.opened.at(-1), "dellist:帳戶B");
	(el.querySelector(".sv-list-add") as HTMLButtonElement).click();
	assert.equal(plugin.opened.at(-1), "list:new");
});

test("選的清單不存在了（被刪或改名）就回到全部", async () => {
	ob.__setRequestHandler(async () => ({ status: 200, json: chart({}) }));
	const { el, plugin, ls } = await mount([
		["Portfolio/A/X.md", note({ ticker: "X", shares: 1 })],
		["Portfolio/B/Y.md", note({ ticker: "Y", shares: 1 })],
	]);
	ls.set(LS_LIST, "不見了");
	await plugin.feed.round();
	assert.match(text(el.querySelector(".sv-list-tab.is-active")!), /^全部/);
});

test("估值區間顯示合理價位：色條上的細線和「現價高／低 x%」；只填合理價位也顯示", async () => {
	ob.__setRequestHandler(async (r: { url: string }) => ({ status: 200, json: chart({ price: r.url.includes("/AAA?") ? 220 : 90, prev: 100 }) }));
	const { el, plugin } = await mount([
		["Portfolio/AAA.md", note({ ticker: "AAA", shares: 1, cost: 1, low: 150, fair: 200, high: 250 })],
		["Portfolio/BBB.md", note({ ticker: "BBB", shares: 1, cost: 1, fair: 100 })],
	]);
	await plugin.feed.round();
	const row = (t: string) => [...el.querySelectorAll("tbody tr")].find((tr) => text(tr).startsWith(t))!;
	const a = row("AAA").querySelector(".sv-c-range")!;
	assert.equal((a.querySelector(".sv-fair-tick") as HTMLElement).style.left, "50%");
	assert.match(text(a), /合理 \$200\.00，現價高 10\.0%/);
	const b = row("BBB").querySelector(".sv-c-range")!;
	assert.equal(b.querySelector(".sv-bar"), null, "沒有上下限就沒有色條");
	assert.match(text(b), /合理 \$100\.00，現價低 10\.0%/);
});

test("手指按著的時候不重畫（點擊不會落空），放開後補畫", async () => {
	let price = 10;
	ob.__setRequestHandler(async () => ({ status: 200, json: chart({ price, prev: 10 }) }));
	const { el, plugin, view } = await mount([["Portfolio/AAA.md", note({ ticker: "AAA", shares: 1, cost: 1 })]]);
	await plugin.feed.round();
	const btn = el.querySelector("tbody .sv-ticker") as HTMLButtonElement;
	const ev = (type: string) => el.dispatchEvent(new (window as any).Event(type, { bubbles: true }));
	ev("pointerdown");
	price = 20;
	await plugin.feed.round();
	assert.equal(el.querySelector("tbody .sv-ticker"), btn, "按著的時候沒有換掉按鈕");
	assert.match(text(el.querySelector("tbody .sv-price")!), /10\.00/);
	ev("pointerup");
	await new Promise((r) => setTimeout(r, 120));
	assert.match(text(el.querySelector("tbody .sv-price")!), /20\.00/, "放開後補畫");
	// 沒收到「放開」：3 秒後照常更新，畫面不會卡住
	ev("pointerdown");
	(view as any).pressedAt = Date.now() - 4000;
	price = 30;
	await plugin.feed.round();
	assert.match(text(el.querySelector("tbody .sv-price")!), /30\.00/);
});
