// v0.10.0：個股走勢圖（使用者 2026-11-23：點代號就能看線圖）——自己設的估值價位和成本畫成虛線，1日含盤前盤後
import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketData, RangeDef, Series, chartUrl, parseSeries, rangeOf } from "../src/markets";
import { drawChart, makeScale, placeLevels } from "../src/chart";
import { LS_STOCK_RANGE, StockChartModal, chartLevels, levelText } from "../src/stockchart";
import { computeRow } from "../src/calc";
import { DEFAULT_SETTINGS } from "../src/config";
import { makeApp } from "./helpers/app";

const R1D = rangeOf("1d");
const text = (e: Element | null) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 編的交易日：盤前 1000～2000、盤中 2000～4000、盤後 4000～5000（秒）
const DAYP = { pre: { start: 1000, end: 2000 }, regular: { start: 2000, end: 4000 }, post: { start: 4000, end: 5000 } };
function json(o: { bars: [number, number][]; periods?: unknown; current?: unknown }) {
	return {
		chart: {
			result: [
				{
					meta: { symbol: "AAA", regularMarketPrice: 105, chartPreviousClose: 100, gmtoffset: 0, currentTradingPeriod: o.current ?? {}, ...(o.periods ? { tradingPeriods: o.periods } : {}) },
					timestamp: o.bars.map((b) => b[0]),
					indicators: { quote: [{ close: o.bars.map((b) => b[1]) }] },
				},
			],
		},
	};
}

test("個股 1日連盤前盤後一起抓：x 軸從盤前到盤後，盤前、盤後是淺色底", () => {
	assert.match(chartUrl("AAA", R1D, true), /range=1d&interval=5m&includePrePost=true$/);
	assert.doesNotMatch(chartUrl("AAA", R1D), /includePrePost/, "指數照舊");
	const bars: [number, number][] = [
		[1200, 101],
		[2500, 103],
		[4300, 105],
	];
	// tradingPeriods：{pre, regular, post} 各是「每天一個陣列」
	const s = parseSeries(json({ bars, periods: { pre: [[DAYP.pre]], regular: [[DAYP.regular]], post: [[DAYP.post]] } }), R1D, 4500, true);
	assert.deepEqual(s.domain, [1000, 5000]);
	assert.deepEqual(s.ext, [
		[1000, 2000],
		[4000, 5000],
	]);
	// 沒有 tradingPeriods：用 currentTradingPeriod（對得上時）
	assert.deepEqual(parseSeries(json({ bars, current: DAYP }), R1D, 4500, true).domain, [1000, 5000]);
	// 週末：currentTradingPeriod 已經是下一個交易日，對不上就不用時間當 x 軸（照點的順序畫）
	const next = { pre: { start: 90000, end: 91000 }, regular: { start: 91000, end: 93000 }, post: { start: 93000, end: 94000 } };
	const wk = parseSeries(json({ bars, current: next }), R1D, 99999, true);
	assert.equal(wk.domain, null);
	assert.equal(wk.ext, undefined);
	// 沒有要盤前盤後：照舊只看盤中
	assert.equal(parseSeries(json({ bars, current: DAYP }), R1D, 4500).ext, undefined);
});

const pts = [100, 104, 102, 106].map((v, i) => ({ t: i, v }));

test("價位線：離價格範圍太遠的只在上下緣標箭頭，不把價格線壓扁", () => {
	const lv = placeLevels(pts, 100, [
		{ v: 140, label: "上限", kind: "high" },
		{ v: 105, label: "合理", kind: "fair" },
		{ v: 98, label: "成本", kind: "cost" },
		{ v: 60, label: "下限", kind: "low" },
	]);
	// 價格 100～106，範圍 6：往上、往下最多各多留 3
	assert.deepEqual(
		[lv.inside.map((l) => l.label), lv.above.map((l) => l.label), lv.below.map((l) => l.label)],
		[["成本", "合理"], ["上限"], ["下限"]],
	);
	const sc = makeScale(pts, 100, null, [98]);
	assert.deepEqual([sc.yMin, sc.yMax], [98, 106], "畫在圖裡的線也算進 y 軸");
	assert.equal(sc.xt, null);
});

test("走勢圖畫出價位虛線、名稱、上下緣箭頭；依時間畫時有盤前盤後的淺色底", () => {
	const el = document.createElement("div");
	drawChart(el, {
		points: [
			{ t: 1200, v: 100 },
			{ t: 2500, v: 104 },
			{ t: 4300, v: 106 },
		],
		base: 100,
		domain: [1000, 5000],
		dir: "up",
		fmtValue: (v) => `$${v}`,
		fmtTime: String,
		axisStart: "a",
		axisEnd: "b",
		label: "x",
		levels: [
			{ v: 103, label: "合理", kind: "fair" },
			{ v: 200, label: "上限", kind: "high" },
		],
		bands: [
			[1000, 2000],
			[4000, 5000],
		],
	});
	assert.equal(el.querySelectorAll("line.sv-chart-lvl").length, 1);
	assert.ok(el.querySelector("line.sv-lvl-fair"));
	assert.equal(text(el.querySelector(".sv-chart-lvl-lab")), "合理 $103");
	assert.equal(text(el.querySelector(".sv-chart-edge.is-top")), "↑ 上限 $200");
	const bands = [...el.querySelectorAll("rect.sv-chart-band")];
	assert.deepEqual(
		bands.map((b) => [b.getAttribute("x"), b.getAttribute("width")]),
		[
			["0.0", "150.0"],
			["450.0", "150.0"],
		],
	);
	const plain = document.createElement("div");
	drawChart(plain, { points: pts, base: 100, domain: null, dir: "up", fmtValue: String, fmtTime: String, axisStart: "", axisEnd: "", label: "", bands: [[0, 1]] });
	assert.equal(plain.querySelectorAll("rect").length, 0, "照點的順序畫時沒有淺色底");
});

const holding = (o: Partial<{ shares: number | null; cost: number | null; low: number | null; fair: number | null; high: number | null }>) => ({
	ticker: "AAA",
	list: "",
	lists: [""],
	paths: ["Portfolio/AAA.md"],
	shares: null,
	cost: null,
	low: null,
	fair: null,
	high: null,
	...o,
});
const quote = { price: 105, prevClose: 100, currency: "USD", name: "Alpha Corp", session: "post" as const, ext: { price: 106, at: 0 } as any, at: 0 };

test("要畫的價位：下限、合理、上限；有持股又有成本才畫成本", () => {
	const row = computeRow(holding({ shares: 10, cost: 80, low: 90, fair: 110, high: 130 }), quote);
	assert.deepEqual(
		chartLevels(row).map((l) => `${l.kind}:${l.v}`),
		["low:90", "fair:110", "high:130", "cost:80"],
	);
	assert.deepEqual(chartLevels(computeRow(holding({ shares: 0, cost: 80, low: 90 }), quote)).map((l) => l.kind), ["low"], "0 股不畫成本");
	assert.equal(levelText({ v: 100, label: "下限", kind: "low" }, 106, "USD"), "下限 $100.00，現價高 6.0%");
	assert.equal(levelText({ v: 110, label: "合理", kind: "fair" }, 99, "USD"), "合理 $110.00，現價低 10.0%");
	assert.equal(levelText({ v: 100, label: "成本", kind: "cost" }, 100.2, "USD"), "成本 $100.00，現價接近");
});

function series(r: RangeDef): Series {
	return { symbol: "AAA", points: [100, 103, 105].map((v, i) => ({ t: 1000 + i * 60, v })), base: 100, last: 105, gmtoffset: 0, session: "post", domain: null };
}

test("走勢圖視窗：報價、期間、價位線和離現價多遠；換期間會記住", async (t) => {
	const { app, ls } = makeApp(new Map());
	const calls: string[] = [];
	const data = new MarketData(async (s, r) => {
		calls.push(`${s}@${r.id}`);
		if (r.id === "5y") throw new Error("Yahoo HTTP 500");
		return series(r);
	});
	const row = computeRow(holding({ shares: 10, cost: 80, low: 100, fair: 104, high: 130 }), quote);
	const plugin: any = { app, settings: { ...DEFAULT_SETTINGS }, feed: { quotes: new Map([["AAA", quote]]) } };
	const m = new StockChartModal(app, plugin, row, data);
	m.open();
	t.after(() => m.close()); // 失敗時也要關掉，不然每分鐘更新的計時器讓測試結束不了
	await sleep(10);
	const el = m.contentEl;
	assert.match((m as any).title, /AAA\s+Alpha Corp/);
	assert.match(text(el.querySelector(".sv-sc-price")), /\$105\.00\s*\+5\.00（\+5\.00%）\s*盤後/);
	assert.equal(text(el.querySelector(".sv-sc-ext")), "盤後 $106.00（+0.95%）");
	assert.equal(text(el.querySelector(".sv-range-btn.is-active")), "1日");
	assert.deepEqual(calls, ["AAA@1d"]);
	assert.match(text(el.querySelector(".sv-sc-period")), /比昨收 \+5\.00（\+5\.00%）/);
	assert.deepEqual(
		[...el.querySelectorAll(".sv-chart-lvl-lab")].map(text),
		["合理 $104.00", "下限 $100.00"],
		"價格 100～105：合理、下限畫在圖裡",
	);
	assert.match(text(el.querySelector(".sv-chart-edge.is-top")), /上限 \$130\.00/);
	assert.match(text(el.querySelector(".sv-chart-edge.is-bottom")), /成本 \$80\.00/);
	// 離現價多遠：盤後用延長時段價（106），和警示一樣
	assert.deepEqual(
		[...el.querySelectorAll(".sv-sc-level")].map(text),
		["上限 $130.00，現價低 18.5%", "合理 $104.00，現價高 1.9%", "下限 $100.00，現價高 6.0%", "成本 $80.00，現價高 32.5%"],
	);

	const btn = (label: string) => [...el.querySelectorAll(".sv-range-btn")].find((b) => text(b) === label) as HTMLButtonElement;
	btn("1年").click();
	await sleep(10);
	assert.equal(ls.get(LS_STOCK_RANGE), "1y");
	assert.deepEqual(calls, ["AAA@1d", "AAA@1y"]);
	assert.match(text(el.querySelector(".sv-sc-period")), /1年來/);
	btn("5年").click();
	await sleep(10);
	assert.match(text(el.querySelector(".sv-err")), /拿不到走勢：Yahoo HTTP 500/);
	m.close();

	// 下次打開記得上次選的期間；沒設估值價位時提示怎麼設
	const m2 = new StockChartModal(app, plugin, computeRow(holding({}), quote), data);
	m2.open();
	t.after(() => m2.close());
	await sleep(10);
	assert.equal(text(m2.contentEl.querySelector(".sv-range-btn.is-active")), "5年");
	assert.match(text(m2.contentEl.querySelector(".sv-sc-levels")), /還沒設估值價位/);
	m2.close();
});
