import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRow, effectivePrice, fairPos, rangeState, toBase, totals, vsFair } from "../src/calc";
import type { Holding } from "../src/holdings";
import type { Quote } from "../src/quote";

const H = (o: Partial<Holding>): Holding => ({ ticker: "AAA", list: "", lists: [""], shares: 10, cost: 100, low: null, high: null, fair: null, paths: ["P/x.md"], ...o });
const Q = (o: Partial<Quote>): Quote => ({ price: 110, prevClose: 105, currency: "USD", name: "", session: "regular", ext: null, at: 0, ...o });

test("單檔：市值、未實現損益、今日漲跌", () => {
	const r = computeRow(H({}), Q({}));
	assert.equal(r.value, 1100);
	assert.equal(r.costTotal, 1000);
	assert.equal(r.pl, 100);
	assert.equal(r.plPct, 10);
	assert.equal(r.dayChg, 5);
	assert.equal(r.dayPl, 50);
	assert.ok(Math.abs(r.dayPct! - 4.7619) < 1e-3);
});

test("沒有報價、只追蹤", () => {
	const r = computeRow(H({}), null);
	assert.equal(r.value, null);
	assert.equal(r.pl, null);
	const w = computeRow(H({ shares: null, cost: null }), Q({}));
	assert.equal(w.value, null);
	assert.equal(w.dayChg, 5);
	assert.equal(w.dayPl, null);
});

test("警示用的價格：盤前盤後用延長時段價（可關）", () => {
	const q = Q({ session: "post", ext: { kind: "post", price: 120 } });
	assert.equal(effectivePrice(q, true), 120);
	assert.equal(effectivePrice(q, false), 110);
	assert.equal(effectivePrice(Q({ session: "regular", ext: { kind: "pre", price: 99 } }), true), 110);
});

test("總計：只追蹤的不算；沒成本的不算損益；換算台股", () => {
	const rows = [
		computeRow(H({ ticker: "A" }), Q({})), // 市值 1100、成本 1000、今日 +50
		computeRow(H({ ticker: "B", cost: null }), Q({ price: 50, prevClose: 50 })), // 市值 500，沒成本
		computeRow(H({ ticker: "C", shares: null }), Q({})), // 只追蹤
		computeRow(H({ ticker: "2330.TW", shares: 100, cost: 900 }), Q({ price: 1000, prevClose: 980, currency: "TWD" })), // 市值 NT$100,000
	];
	const t = totals(rows, "USD", 32);
	assert.ok(Math.abs(t.value - (1100 + 500 + 100000 / 32)) < 1e-6);
	assert.ok(Math.abs(t.cost - (1000 + 90000 / 32)) < 1e-6);
	assert.ok(Math.abs(t.pl - (100 + 10000 / 32)) < 1e-6);
	assert.ok(Math.abs(t.day - (50 + 2000 / 32)) < 1e-6);
	assert.equal(t.needsFx, true);
	assert.equal(t.fxMissing, false);
	assert.equal(totals(rows, "USD", null).fxMissing, true);
	const tw = totals([rows[0]], "TWD", 30);
	assert.equal(tw.value, 33000);
});

test("沒有報價的持股計數", () => {
	const t = totals([computeRow(H({}), null)], "USD", null);
	assert.equal(t.missing, 1);
	assert.equal(t.value, 0);
	assert.equal(t.plPct, null);
});

test("toBase", () => {
	assert.equal(toBase(10, "USD", "USD", null), 10);
	assert.equal(toBase(10, "USD", "TWD", 31), 310);
	assert.equal(toBase(310, "TWD", "USD", 31), 10);
});

test("估值區間位置與突破／跌破", () => {
	assert.deepEqual(rangeState(175, 150, 200), { state: "inside", pos: 50 });
	assert.deepEqual(rangeState(210, 150, 200), { state: "above", pos: 100 });
	assert.deepEqual(rangeState(140, 150, 200), { state: "below", pos: 0 });
	assert.deepEqual(rangeState(140, 150, null), { state: "below", pos: null });
	assert.deepEqual(rangeState(140, null, null), { state: null, pos: null });
	assert.deepEqual(rangeState(null, 1, 2), { state: null, pos: null });
});

test("合理價位：現價比它貴或便宜多少、在色條上的位置", () => {
	assert.equal(vsFair(110, 100), 10);
	assert.equal(vsFair(90, 100), -10);
	assert.equal(vsFair(null, 100), null);
	assert.equal(vsFair(90, null), null);
	assert.equal(fairPos(175, 150, 200), 50);
	assert.equal(fairPos(175, null, 200), null);
	assert.equal(fairPos(null, 150, 200), null);
});
