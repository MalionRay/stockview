import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chartUrl, fetchQuote, isUsTicker, isValidTicker, normalizeTicker, parseChart } from "../src/quote";
import { chart } from "./fixtures";
const ob = require("obsidian");

test("盤中：價格、昨收、名稱，沒有延長時段價", () => {
	const q = parseChart(chart({ price: 101.5, prev: 100, name: "Foo Inc", bars: [[2500, 101.4]] }), 2500, 7);
	assert.equal(q.session, "regular");
	assert.equal(q.price, 101.5);
	assert.equal(q.prevClose, 100);
	assert.equal(q.name, "Foo Inc");
	assert.equal(q.ext, null);
	assert.equal(q.at, 7);
});

test("盤前：最後一根 K 在盤前區間＝盤前價", () => {
	const q = parseChart(chart({ price: 100, bars: [[1100, 102], [1200, 103.2], [1300, null]] }), 1500);
	assert.equal(q.session, "pre");
	assert.deepEqual(q.ext, { kind: "pre", price: 103.2 });
});

test("盤後與收盤後：最後一根 K 在盤後區間＝盤後價", () => {
	const data = chart({ price: 100, bars: [[2900, 100], [3100, 98.5]] });
	assert.equal(parseChart(data, 3500).session, "post");
	assert.deepEqual(parseChart(data, 3500).ext, { kind: "post", price: 98.5 });
	const closed = parseChart(data, 5000);
	assert.equal(closed.session, "closed");
	assert.deepEqual(closed.ext, { kind: "post", price: 98.5 });
});

test("沒有 chartPreviousClose 時用 previousClose；查無資料丟錯", () => {
	const d = chart({});
	const meta = d.chart.result[0].meta as Record<string, unknown>;
	delete meta.chartPreviousClose;
	meta.previousClose = 90;
	assert.equal(parseChart(d, 2500).prevClose, 90);
	assert.throws(() => parseChart({ chart: { result: null, error: { description: "No data found" } } }), /No data found/);
});

test("fetchQuote：404、429、成功", async () => {
	ob.__setRequestHandler(async (r: { url: string }) => {
		if (r.url.includes("/NOPE?")) return { status: 404, json: {} };
		if (r.url.includes("/BUSY?")) return { status: 429, json: {} };
		return { status: 200, json: chart({ price: 42 }) };
	});
	await assert.rejects(fetchQuote("NOPE"), /找不到/);
	await assert.rejects(fetchQuote("BUSY"), (e: { status?: number }) => e.status === 429);
	assert.equal((await fetchQuote("OK")).price, 42);
	assert.match(chartUrl("BRK-B"), /chart\/BRK-B\?.*includePrePost=true/);
});

test("代號正規化與檢查", () => {
	assert.equal(normalizeTicker(" brk-b "), "BRK-B");
	assert.ok(isValidTicker("2330.TW"));
	assert.ok(isValidTicker("^GSPC"));
	assert.ok(!isValidTicker("AA PL"));
	assert.ok(!isValidTicker("<script>"));
	assert.ok(isUsTicker("NVDA"));
	assert.ok(isUsTicker("BRK-B"));
	assert.ok(!isUsTicker("2330.TW"));
	assert.ok(!isUsTicker("TWD=X"));
});

test("交易時段已經換成下一個交易日（半夜、週末）時，還是認得出上一個交易日的盤後價", () => {
	// K 線是「昨天」的（盤中到 3000、盤後 3100），交易時段是「今天」的（從 100000 開始）
	const next = { pre: { start: 100000, end: 101000 }, regular: { start: 101000, end: 102000 }, post: { start: 102000, end: 103000 } };
	const d = chart({ price: 100, bars: [[2900, 100], [3100, 98.5]], period: next });
	(d.chart.result[0].meta as Record<string, unknown>).regularMarketTime = 3000;
	const q = parseChart(d, 50000);
	assert.equal(q.session, "closed");
	assert.deepEqual(q.ext, { kind: "post", price: 98.5 });
	// 盤中最後一筆之後沒有更晚的 K → 沒有延長時段價
	const none = chart({ price: 100, bars: [[2900, 100]], period: next });
	(none.chart.result[0].meta as Record<string, unknown>).regularMarketTime = 3000;
	assert.equal(parseChart(none, 50000).ext, null);
	// 隔了很久（隔天清晨）的 K＝盤前
	const pre = chart({ price: 100, bars: [[2900, 100], [3000 + 12 * 3600, 101]], period: next });
	(pre.chart.result[0].meta as Record<string, unknown>).regularMarketTime = 3000;
	assert.deepEqual(parseChart(pre, 50000).ext, { kind: "pre", price: 101 });
	// 沒有 regularMarketTime 就照舊（不猜）
	assert.equal(parseChart(chart({ price: 100, bars: [[2900, 100], [3100, 98.5]], period: next }), 50000).ext, null);
});
