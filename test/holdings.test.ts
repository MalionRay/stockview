import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAIN_LIST,
	addHolding,
	checkInput,
	checkListName,
	createList,
	deleteList,
	listOf,
	mergeAcrossLists,
	mergeHoldings,
	moveHolding,
	num,
	readHoldings,
	readLists,
	renameList,
	updateHolding,
	visibleLists,
} from "../src/holdings";
import { makeApp } from "./helpers/app";
import { note } from "./fixtures";

test("num：空白、文字、逗號", () => {
	assert.equal(num(""), null);
	assert.equal(num(null), null);
	assert.equal(num("abc"), null);
	assert.equal(num("1,200.5"), 1200.5);
	assert.equal(num(7), 7);
});

test("讀資料夾裡的股票筆記：沒有 ticker 的略過，代號轉大寫，股數空白＝只追蹤", () => {
	const { app } = makeApp(
		new Map([
			["Portfolio/NVDA.md", note({ ticker: "nvda", shares: 50, cost: "120.5", low: 150, high: 220 })],
			["Portfolio/WATCH.md", note({ ticker: "MSFT", shares: "", cost: "", low: "", high: 500 })],
			["Portfolio/readme.md", "# 說明\n"],
			["Other/AAPL.md", note({ ticker: "AAPL", shares: 10 })],
		]),
	);
	const hs = readHoldings(app, "Portfolio");
	assert.deepEqual(
		hs.map((h) => h.ticker),
		["NVDA", "MSFT"],
	);
	const nv = hs[0];
	assert.equal(nv.shares, 50);
	assert.equal(nv.cost, 120.5);
	assert.equal(nv.low, 150);
	assert.equal(nv.high, 220);
	const ms = hs[1];
	assert.equal(ms.shares, null);
	assert.equal(ms.high, 500);
});

test("同一檔分好幾篇：股數相加、成本加權平均", () => {
	const [h] = mergeHoldings([
		{ ticker: "AAPL", shares: 10, cost: 100, low: null, high: 250, path: "P/a.md", list: "" },
		{ ticker: "AAPL", shares: 30, cost: 200, low: 150, high: 300, path: "P/b.md", list: "" },
	]);
	assert.equal(h.shares, 40);
	assert.equal(h.cost, 175);
	assert.equal(h.low, 150);
	assert.equal(h.high, 250);
	assert.deepEqual(h.paths, ["P/a.md", "P/b.md"]);
});

test("檢查輸入", () => {
	const ok = { ticker: "AAPL", shares: 1, cost: 1, low: 1, high: 2 };
	assert.equal(checkInput(ok), null);
	assert.match(checkInput({ ...ok, ticker: "A B" })!, /代號/);
	assert.match(checkInput({ ...ok, shares: -1 })!, /股數/);
	assert.match(checkInput({ ...ok, low: 3 })!, /下限/);
});

test("新增筆記與修改 frontmatter（內文不動）", async () => {
	const { app, files } = makeApp();
	await addHolding(app, "Portfolio", MAIN_LIST, { ticker: "AMD", shares: 5, cost: 99.9, low: null, high: 200 });
	const s = String(files.get("Portfolio/AMD.md"));
	assert.match(s, /ticker: AMD\nshares: 5\ncost: 99.9\nlow: \nhigh: 200/);
	await assert.rejects(addHolding(app, "Portfolio", MAIN_LIST, { ticker: "AMD", shares: 1, cost: 1, low: null, high: null }), /已經有/);
	await updateHolding(app, "Portfolio/AMD.md", { shares: 8, cost: 90, low: 80, high: null });
	const t = String(files.get("Portfolio/AMD.md"));
	assert.match(t, /shares: 8/);
	assert.match(t, /low: 80/);
	assert.match(t, /## 買進理由/);
	const [h] = readHoldings(app, "Portfolio");
	assert.equal(h.shares, 8);
	assert.equal(h.high, null);
});

test("清單＝子資料夾；直接放在資料夾裡的是主清單；更深的算第一層", () => {
	assert.equal(listOf("Portfolio/NVDA.md", "Portfolio"), MAIN_LIST);
	assert.equal(listOf("Portfolio/AI 概念股/NVDA.md", "Portfolio"), "AI 概念股");
	assert.equal(listOf("Portfolio/帳戶A/2025/NVDA.md", "Portfolio"), "帳戶A");
	assert.equal(listOf("Other/NVDA.md", "Portfolio"), null);
	assert.equal(listOf("PortfolioX/NVDA.md", "Portfolio"), null);
});

test("同一檔在不同清單各自計算；「全部」合併成一列", () => {
	const { app } = makeApp(
		new Map([
			["Portfolio/NVDA.md", note({ ticker: "NVDA", shares: 10, cost: 100, high: 220 })],
			["Portfolio/帳戶B/NVDA.md", note({ ticker: "NVDA", shares: 30, cost: 200, low: 150, high: 250 })],
			["Portfolio/觀察/AMD.md", note({ ticker: "AMD", shares: "", cost: "", high: 300 })],
		]),
	);
	const hs = readHoldings(app, "Portfolio");
	assert.deepEqual(
		hs.map((h) => `${h.list}:${h.ticker}:${h.shares}`),
		[":NVDA:10", "帳戶B:NVDA:30", "觀察:AMD:null"],
	);
	const all = mergeAcrossLists(hs);
	const nv = all.find((h) => h.ticker === "NVDA")!;
	assert.equal(nv.shares, 40);
	assert.equal(nv.cost, 175);
	assert.equal(nv.high, 220, "上下限用主清單（第一個）有填的");
	assert.equal(nv.low, 150);
	assert.deepEqual(nv.lists, ["", "帳戶B"]);
	assert.equal(nv.paths.length, 2);
	assert.deepEqual(readLists(app, "Portfolio", hs), ["", "帳戶B", "觀察"]);
});

test("清單列表：空的子資料夾也算；主清單沒有股票又有其他清單時不顯示", async () => {
	const { app } = makeApp(new Map([["Portfolio/A/X.md", note({ ticker: "X", shares: 1 })]]));
	await createList(app, "Portfolio", "B");
	const hs = readHoldings(app, "Portfolio");
	const lists = readLists(app, "Portfolio", hs);
	assert.deepEqual(lists, ["", "A", "B"]);
	assert.deepEqual(visibleLists(lists, hs), ["A", "B"]);
	assert.deepEqual(visibleLists([""], []), [""], "什麼都沒有時顯示主清單");
});

test("清單名稱檢查", () => {
	assert.equal(checkListName("AI 概念股", []), null);
	assert.match(checkListName("  ", [])!, /請輸入/);
	assert.match(checkListName("a/b", [])!, /不能有/);
	assert.match(checkListName(".hidden", [])!, /不能有/);
	assert.match(checkListName("主清單", [])!, /保留/);
	assert.match(checkListName("全部", [])!, /保留/);
	assert.match(checkListName("ai", ["AI"])!, /已經有/);
	assert.match(checkListName("x".repeat(31), [])!, /30/);
});

test("新增到清單、移到別的清單、清單改名、刪除清單", async () => {
	const { app, files } = makeApp();
	await addHolding(app, "Portfolio", "長期", { ticker: "AAPL", shares: 1, cost: 1, low: null, high: null });
	assert.ok(files.has("Portfolio/長期/AAPL.md"));
	await addHolding(app, "Portfolio", "短線", { ticker: "AAPL", shares: 2, cost: 2, low: null, high: null });
	await assert.rejects(moveHolding(app, "Portfolio", "Portfolio/長期/AAPL.md", "AAPL", "短線"), /已經有/);
	await createList(app, "Portfolio", "觀察");
	await moveHolding(app, "Portfolio", "Portfolio/長期/AAPL.md", "AAPL", "觀察");
	assert.ok(files.has("Portfolio/觀察/AAPL.md"));
	assert.ok(!files.has("Portfolio/長期/AAPL.md"));
	await renameList(app, "Portfolio", "短線", "波段");
	assert.ok(files.has("Portfolio/波段/AAPL.md"));
	assert.deepEqual(
		readHoldings(app, "Portfolio").map((h) => h.list),
		["波段", "觀察"],
	);
	await deleteList(app, "Portfolio", "波段");
	assert.ok(!files.has("Portfolio/波段/AAPL.md"));
	await assert.rejects(deleteList(app, "Portfolio", MAIN_LIST), /主清單/);
});
