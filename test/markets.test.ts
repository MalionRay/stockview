import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MARKETS, MarketData, RANGES, chartUrl, combineSeries, fetchChart, fmtLevel, parseSeries, rangeOf, scaleSeries, timeLabel } from "../src/markets";
const ob = require("obsidian");

const R1D = rangeOf("1d");
const R1Y = rangeOf("1y");

function chart(o: { bars: [number, number | null][]; prev?: number; price?: number; regular?: { start: number; end: number }; gmtoffset?: number }) {
	return {
		chart: {
			result: [
				{
					meta: {
						symbol: "^TEST",
						regularMarketPrice: o.price ?? o.bars[o.bars.length - 1]?.[1],
						chartPreviousClose: o.prev,
						gmtoffset: o.gmtoffset ?? 0,
						currentTradingPeriod: o.regular ? { regular: o.regular } : {},
					},
					timestamp: o.bars.map((b) => b[0]),
					indicators: { quote: [{ close: o.bars.map((b) => b[1]) }] },
				},
			],
		},
	};
}

test("每個市場都有項目，代號不重複；期間設定", () => {
	assert.deepEqual(
		MARKETS.map((m) => m.label),
		["美股", "台股", "日股", "陸股", "韓股", "歐股", "匯率"],
	);
	for (const m of MARKETS) {
		assert.ok(m.items.length >= 2, m.label);
		assert.equal(new Set(m.items.map((i) => i.symbol)).size, m.items.length);
	}
	assert.deepEqual(
		RANGES.map((r) => r.label),
		["1日", "5日", "1月", "6月", "今年", "1年", "5年"],
	);
	assert.equal(rangeOf("nope").id, "1d");
	assert.match(chartUrl("^N225", rangeOf("5y")), /chart\/%5EN225\?range=5y&interval=1wk$/);
});

test("解析：跳過空值；1日用交易時段當 x 範圍；基準＝昨收", () => {
	const s = parseSeries(chart({ bars: [[1000, 10], [1300, null], [1600, 12]], prev: 11, regular: { start: 1000, end: 4000 } }), R1D, 1700);
	assert.deepEqual(
		s.points.map((p) => p.v),
		[10, 12],
	);
	assert.equal(s.base, 11);
	assert.equal(s.last, 12);
	assert.equal(s.session, "regular");
	assert.deepEqual(s.domain, [1000, 4000]);
	const y = parseSeries(chart({ bars: [[1000, 10], [2000, 12]] }), R1Y, 5000);
	assert.equal(y.domain, null);
	assert.equal(y.base, 10, "沒有昨收就用第一點");
	assert.equal(y.session, "closed");
	assert.throws(() => parseSeries(chart({ bars: [[1, null]] }), R1D), /沒有資料/);
	assert.throws(() => parseSeries({ chart: { result: null, error: { description: "No data found" } } }, R1D), /No data found/);
});

test("交叉匯率：100 日圓＝台幣/美元 ÷ 日圓/美元 × 100；歐元＝歐元/美元 × 台幣/美元", () => {
	const twd = parseSeries(chart({ bars: [[0, 32], [60, 32.4]], prev: 31.8 }), R1D);
	const jpy = parseSeries(chart({ bars: [[0, 150], [30, 151], [60, 160]], prev: 150 }), R1D);
	const s = scaleSeries(combineSeries("JPYTWD=X", [twd], [jpy]), 100);
	assert.deepEqual(
		s.points.map((p) => +p.v.toFixed(4)),
		[21.3333, 20.25],
	);
	assert.equal(+s.base!.toFixed(4), 21.2);
	const eur = parseSeries(chart({ bars: [[0, 1.1], [60, 1.2]], prev: 1.1 }), R1D);
	const e = combineSeries("EURTWD=X", [eur, twd], []);
	assert.equal(+e.last!.toFixed(3), 38.88);
});

test("抓資料：交叉匯率拿不到就用美元匯率換算；有快取；429 不換算", async () => {
	const calls: string[] = [];
	ob.__setRequestHandler(async (r: { url: string }) => {
		const sym = decodeURIComponent(r.url.match(/chart\/([^?]+)/)![1]);
		calls.push(sym);
		if (sym === "JPYTWD=X") return { status: 404, json: {} };
		if (sym === "TWD=X") return { status: 200, json: chart({ bars: [[0, 32]], prev: 32 }) };
		if (sym === "JPY=X") return { status: 200, json: chart({ bars: [[0, 160]], prev: 160 }) };
		if (sym === "BUSY") return { status: 429, json: {} };
		return { status: 200, json: chart({ bars: [[0, 1]] }) };
	});
	const d = new MarketData();
	const jp = MARKETS.find((m) => m.id === "fx")!.items.find((i) => i.symbol === "JPYTWD=X")!;
	const s = await d.get(jp, R1D, 1000);
	assert.equal(s.last, 20, "100 日圓＝20 台幣");
	assert.deepEqual(calls, ["JPYTWD=X", "TWD=X", "JPY=X"]);
	await d.get(jp, R1D, 2000);
	assert.equal(calls.length, 3, "1 分鐘內用快取");
	assert.equal(d.cached(jp, R1D)?.last, 20, "快取也要乘倍數");
	await d.get(jp, R1D, 1000 + 61_000);
	assert.ok(calls.length > 3, "過期重抓");
	await assert.rejects(d.get({ symbol: "BUSY", name: "x", fallback: { mul: ["TWD=X"], div: [] } }, R1D), /太頻繁/);
	await assert.rejects(fetchChart("JPYTWD=X", R1D), /沒有這個代號/);
});

test("時間文字用交易所當地時間", () => {
	const t = Date.UTC(2026, 10, 6, 14, 30) / 1000; // UTC 14:30
	assert.equal(timeLabel(t, -5 * 3600, R1D), "09:30");
	assert.equal(timeLabel(t, 9 * 3600, rangeOf("5d")), "11/6 23:30");
	assert.equal(timeLabel(t, 0, R1Y), "11/6");
	assert.equal(timeLabel(t, 0, R1Y, true), "2026/11/6");
	assert.equal(timeLabel(t, 0, rangeOf("5y")), "2026/11");
	assert.equal(fmtLevel(23456.789), "23,456.79");
	assert.equal(fmtLevel(4.56789, true), "4.5679");
	assert.equal(fmtLevel(32.12345, true), "32.123");
	assert.equal(fmtLevel(null), "—");
});
