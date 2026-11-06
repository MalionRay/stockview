import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { addHolding, checkInput, mergeHoldings, num, readHoldings, updateHolding } from "../src/holdings";
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
		{ ticker: "AAPL", shares: 10, cost: 100, low: null, high: 250, path: "P/a.md" },
		{ ticker: "AAPL", shares: 30, cost: 200, low: 150, high: 300, path: "P/b.md" },
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
	await addHolding(app, "Portfolio", { ticker: "AMD", shares: 5, cost: 99.9, low: null, high: 200 });
	const s = String(files.get("Portfolio/AMD.md"));
	assert.match(s, /ticker: AMD\nshares: 5\ncost: 99.9\nlow: \nhigh: 200/);
	await assert.rejects(addHolding(app, "Portfolio", { ticker: "AMD", shares: 1, cost: 1, low: null, high: null }), /已經有/);
	await updateHolding(app, "Portfolio/AMD.md", { shares: 8, cost: 90, low: 80, high: null });
	const t = String(files.get("Portfolio/AMD.md"));
	assert.match(t, /shares: 8/);
	assert.match(t, /low: 80/);
	assert.match(t, /## 買進理由/);
	const [h] = readHoldings(app, "Portfolio");
	assert.equal(h.shares, 8);
	assert.equal(h.high, null);
});
