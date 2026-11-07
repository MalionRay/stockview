import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LS_TXF_POINTS, TAIFEX_URL, TxfTape, fetchTaifex, parseTaifex, sessionKey, txfMarket, txfSession } from "../src/taifex";
import { makeApp } from "./helpers/app";
const ob = require("obsidian");

/** 台北時間 → Unix 秒 */
const tpe = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi) / 1000;

// 2026-11-06 是星期五
test("哪一盤：日盤 08:45～13:45，夜盤 15:00～隔天 05:00；週末收盤", () => {
	assert.equal(txfSession(tpe(2026, 11, 6, 8, 44)), "closed");
	assert.equal(txfSession(tpe(2026, 11, 6, 8, 45)), "day");
	assert.equal(txfSession(tpe(2026, 11, 6, 13, 45)), "closed");
	assert.equal(txfSession(tpe(2026, 11, 6, 15, 0)), "night");
	assert.equal(txfSession(tpe(2026, 11, 7, 4, 59)), "night", "週五夜盤到週六清晨");
	assert.equal(txfSession(tpe(2026, 11, 7, 5, 0)), "closed");
	assert.equal(txfSession(tpe(2026, 11, 8, 20, 0)), "closed", "週日晚上沒有夜盤");
	assert.equal(txfSession(tpe(2026, 11, 9, 3, 0)), "closed", "週一凌晨沒有夜盤");
	assert.equal(txfMarket(tpe(2026, 11, 6, 10)), "0");
	assert.equal(txfMarket(tpe(2026, 11, 6, 14, 30)), "0", "日盤收盤後到夜盤前看日盤");
	assert.equal(txfMarket(tpe(2026, 11, 6, 22)), "1");
	assert.equal(txfMarket(tpe(2026, 11, 7, 12)), "1", "週末看最後的夜盤");
	assert.equal(sessionKey("1", tpe(2026, 11, 6, 23)), sessionKey("1", tpe(2026, 11, 7, 2)), "跨午夜還是同一盤");
	assert.notEqual(sessionKey("1", tpe(2026, 11, 6, 23)), sessionKey("1", tpe(2026, 11, 9, 16)));
});

const sample = {
	RtCode: "0",
	RtData: {
		QuoteList: [
			{ DispCName: "臺指期11/12", CLastPrice: "", CRefPrice: "-", CTime: "" },
			{ DispCName: "臺指期11", CLastPrice: "23,456.00", CRefPrice: "23,400.00", CHighPrice: "23,500", CLowPrice: "23,350", CTime: "235958" },
			{ DispCName: "臺指期12", CLastPrice: "23,480.00", CRefPrice: "23,420.00", CTime: "235958" },
		],
	},
};

test("解析：挑近月、跳過價差、數字去逗號、時間加冒號", () => {
	const q = parseTaifex(sample, "1");
	assert.equal(q.name, "臺指期11");
	assert.equal(q.last, 23456);
	assert.equal(q.ref, 23400);
	assert.equal(q.high, 23500);
	assert.equal(q.low, 23350);
	assert.equal(q.time, "23:59:58");
	assert.throws(() => parseTaifex({ RtCode: "1", RtMsg: "系統忙碌" }, "0"), /系統忙碌/);
	assert.throws(() => parseTaifex({ RtCode: "0", RtData: { QuoteList: [] } }, "0"), /沒有台指期/);
});

test("呼叫期交所：POST JSON，夜盤 MarketType 1，不加偽裝標頭", async () => {
	let req: any;
	ob.__setRequestHandler(async (r: any) => ((req = r), { status: 200, json: sample }));
	const q = await fetchTaifex("1");
	assert.equal(q.last, 23456);
	assert.equal(req.url, TAIFEX_URL);
	assert.equal(req.method, "POST");
	assert.equal(req.contentType, "application/json");
	assert.equal(JSON.parse(req.body).MarketType, "1");
	assert.equal(JSON.parse(req.body).CID, "TXF");
	assert.equal(req.headers, undefined);
	ob.__setRequestHandler(async () => ({ status: 520, json: {} }));
	await assert.rejects(fetchTaifex("0"), /HTTP 520/);
});

test("走勢記錄：價格或時間變了才加點；換盤重來；重開還在", () => {
	const { app, ls } = makeApp();
	const tape = new TxfTape(app);
	const base = { name: "臺指期11", ref: 100, high: null, low: null, market: "1" as const };
	const t0 = tpe(2026, 11, 6, 22);
	tape.add({ ...base, last: 101, time: "22:00:00" }, t0);
	tape.add({ ...base, last: 101, time: "22:00:00" }, t0 + 30);
	tape.add({ ...base, last: 102, time: "22:01:00" }, t0 + 60);
	assert.deepEqual(
		tape.add({ ...base, last: 102, time: "22:01:30" }, t0 + 90).map((p) => p.v),
		[101, 102],
		"價格沒變（5 分鐘內）不加點",
	);
	assert.ok(ls.get(LS_TXF_POINTS));
	assert.equal(new TxfTape(app).points.length, 2);
	const next = tape.add({ ...base, last: 99, time: "15:00:00" }, tpe(2026, 11, 9, 15, 1));
	assert.deepEqual(
		next.map((p) => p.v),
		[99],
	);
});
