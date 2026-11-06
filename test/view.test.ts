import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Alarms } from "../src/alarms";
import { DEFAULT_SETTINGS } from "../src/config";
import { Feed } from "../src/feed";
import { Ratings, SECRET_FINNHUB } from "../src/ratings";
import { DashboardView, LS_SORT } from "../src/view";
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
	plugin.openHoldingModal = (h?: { ticker: string }) => plugin.opened.push("modal:" + (h?.ticker ?? "new"));
	plugin.openDeleteModal = (h: { ticker: string }) => plugin.opened.push("delete:" + h.ticker);
	plugin.openNote = (p: string) => plugin.opened.push("note:" + p);
	plugin.openSettings = () => plugin.opened.push("settings");
	const view = new DashboardView({ app } as never, plugin);
	await view.onOpen();
	return { view, plugin, el: view.contentEl, ls };
}

const text = (el: Element) => el.textContent ?? "";

test("沒有股票：顯示說明和新增按鈕", async () => {
	const { el, plugin } = await mount([]);
	assert.match(text(el), /還沒有股票/);
	(el.querySelector(".sv-empty button") as HTMLButtonElement).click();
	assert.deepEqual(plugin.opened, ["modal:new"]);
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
