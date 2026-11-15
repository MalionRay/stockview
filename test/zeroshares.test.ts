// v0.7.1：「全部」是各清單持股的加總，股數 0 或空白的不列入。數字和代號都是編的。
import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Alarms } from "../src/alarms";
import { computeRow, totals } from "../src/calc";
import { DEFAULT_SETTINGS, LS_LIST } from "../src/config";
import { Feed } from "../src/feed";
import { ALL_LISTS, isHeld } from "../src/holdings";
import { Ratings } from "../src/ratings";
import { DashboardView } from "../src/view";
import StockViewPlugin from "../src/main";
import { makeApp } from "./helpers/app";
import { chart, note } from "./fixtures";
const ob = require("obsidian");

const text = (el: Element | null) => el?.textContent ?? "";

const FILES: [string, string][] = [
	["Portfolio/長期/AAA.md", note({ ticker: "AAA", shares: 10, cost: 50 })],
	["Portfolio/長期/DDD.md", note({ ticker: "DDD", shares: 5, cost: 20 })],
	["Portfolio/短線/AAA.md", note({ ticker: "AAA", shares: 0, cost: 70 })], // 賣光了還在追蹤
	["Portfolio/短線/BBB.md", note({ ticker: "BBB", shares: 0, cost: 30 })],
	["Portfolio/觀察/CCC.md", note({ ticker: "CCC", shares: "" })],
];

async function mount(files: [string, string][], list?: string) {
	const { app, ls } = makeApp(new Map(files));
	if (list !== undefined) ls.set(LS_LIST, list);
	const settings = { ...DEFAULT_SETTINGS };
	const alarms = new Alarms(app);
	const plugin: any = { app, settings, alarms, opened: [] as string[] };
	plugin.ratings = new Ratings(app, () => plugin.feed.emit());
	plugin.feed = new Feed({ app, settings, alarms, ratings: plugin.ratings, viewOpen: () => true, onAlarm: () => undefined });
	for (const k of ["selectedList", "selectList", "defaultAddList"]) plugin[k] = (StockViewPlugin.prototype as any)[k].bind(plugin);
	for (const k of ["openHoldingModal", "openListModal", "openDeleteListModal", "openMoveModal", "openDeleteModal", "openNote", "openSettings", "openAccountModal"]) plugin[k] = () => plugin.opened.push(k);
	plugin.sync = { now: async () => true, soon: () => undefined };
	ob.__setRequestHandler(async () => ({ status: 200, json: chart({ price: 100, prev: 100 }) }));
	const view = new DashboardView({ app } as never, plugin);
	await view.onOpen();
	await plugin.feed.round();
	const el = view.contentEl;
	const tickers = () => [...el.querySelectorAll(".sv-table:not(.sv-break-table) tbody tr")].map((tr) => text(tr.querySelector(".sv-ticker")));
	return { view, plugin, el, tickers };
}

test("有持股＝股數大於 0；股數 0 和空白一樣不算市值、損益", () => {
	assert.equal(isHeld({ shares: 3 }), true);
	assert.equal(isHeld({ shares: 0.5 }), true);
	assert.equal(isHeld({ shares: 0 }), false);
	assert.equal(isHeld({ shares: null }), false);
	const h = { ticker: "BBB", list: "短線", lists: ["短線"], shares: 0, cost: 30, low: null, high: null, fair: null, paths: [] };
	const r = computeRow(h, { price: 100, prevClose: 90, currency: "USD", name: "", session: "closed", ext: null, at: 0 } as never);
	assert.deepEqual({ value: r.value, cost: r.costTotal, pl: r.pl, day: r.dayPl }, { value: null, cost: null, pl: null, day: null });
	const noQuote = computeRow(h, null);
	const t = totals([r, noQuote], "USD", null);
	assert.deepEqual({ value: t.value, cost: t.cost, missing: t.missing }, { value: 0, cost: 0, missing: 0 }, "沒有報價的 0 股不算「還沒有報價」");
});

test("全部的列：只合併股數大於 0 的；某個清單是 0 股，那個清單不算在「在哪些清單」裡", async () => {
	const { app } = makeApp(new Map(FILES));
	const settings = { ...DEFAULT_SETTINGS };
	const alarms = new Alarms(app);
	const feed = new Feed({ app, settings, alarms, ratings: new Ratings(app, () => undefined), viewOpen: () => true, onAlarm: () => undefined });
	feed.reload();
	const all = feed.rows(ALL_LISTS);
	assert.deepEqual(
		all.map((r) => [r.h.ticker, r.h.shares, r.h.cost, r.h.lists]),
		[
			["AAA", 10, 50, ["長期"]],
			["DDD", 5, 20, ["長期"]],
		],
	);
	assert.deepEqual(
		feed.rows("短線").map((r) => [r.h.ticker, r.h.shares]),
		[
			["AAA", 0],
			["BBB", 0],
		],
		"自己的清單裡照樣看得到",
	);
	assert.equal(feed.rows("觀察").length, 1);
});

test("全部的畫面：分頁數字、表格、小計都只算有持股的", async () => {
	const { el, tickers } = await mount(FILES);
	assert.equal(text(el.querySelector(".sv-list-tab.is-active")), "全部2");
	assert.deepEqual(tickers(), ["AAA", "DDD"]);
	assert.deepEqual(
		[...el.querySelectorAll(".sv-table:not(.sv-break-table) .sv-in-lists")].map(text),
		["長期", "長期"],
	);
	assert.match(text(el.querySelector(".sv-card")), /總市值\$1,500\.002 檔持股/);
	assert.deepEqual(
		[...el.querySelectorAll(".sv-break tbody tr .sv-break-name")].map(text),
		["長期"],
		"短線全是 0 股、觀察只有追蹤：不列在小計",
	);
	assert.equal(text(el.querySelector(".sv-break-total td")), "合計");
});

test("自己的清單：0 股的照樣列出，標「0 股」、排在後面、不算市值", async () => {
	const { el, tickers } = await mount(FILES, "短線");
	assert.match(text(el.querySelector(".sv-list-tab.is-active")), /^短線2/);
	assert.deepEqual(tickers(), ["AAA", "BBB"]);
	const rows = [...el.querySelectorAll(".sv-table:not(.sv-break-table) tbody tr")];
	assert.ok(rows.every((tr) => tr.classList.contains("sv-watch")));
	assert.deepEqual(
		rows.map((tr) => text(tr.querySelector(".sv-tag"))),
		["0 股", "0 股"],
	);
	assert.equal((el.querySelector(".sv-cards") as HTMLElement).style.display, "none", "這個清單沒有持股：沒有總計卡片");

	const mixed = await mount([...FILES, ["Portfolio/短線/EEE.md", note({ ticker: "EEE", shares: 2, cost: 90 })]], "短線");
	assert.deepEqual(mixed.tickers(), ["EEE", "AAA", "BBB"], "有持股的在前面");
	assert.match(text(mixed.el.querySelector(".sv-card")), /總市值\$200\.001 檔持股/);
});

test("全部只剩 0 股和只追蹤的：說明它們在各自的清單裡", async () => {
	const { el, tickers } = await mount(FILES.slice(2));
	assert.equal(text(el.querySelector(".sv-list-tab.is-active")), "全部0");
	assert.deepEqual(tickers(), []);
	assert.match(text(el.querySelector(".sv-empty")), /「全部」只列股數大於 0 的持股。只追蹤（股數空白）或 0 股的股票在各自的清單裡。/);
});
