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

// ---- v0.6.0：檢查後修正的問題 ----
import { tapeKey, tradeAgeMin, txfHalted } from "../src/taifex";

test("回應第一列是現貨指數（臺指現貨）時要跳過，挑真正的近月期貨", () => {
	const withSpot = {
		RtCode: "0",
		RtData: {
			QuoteList: [
				{ SymbolID: "TXF-S", DispCName: "臺指現貨", CLastPrice: "23,300.12", CRefPrice: "23,250.00", CTime: "133300" },
				{ SymbolID: "TXFK6-M", DispCName: "臺指期116", CLastPrice: "23,456", CRefPrice: "23,400", CTime: "221500" },
				{ SymbolID: "TXFK6/L6-M", DispCName: "臺指期116/126", CLastPrice: "30", CRefPrice: "28", CTime: "221400" },
			],
		},
	};
	const q = parseTaifex(withSpot, "1");
	assert.equal(q.name, "臺指期116");
	assert.equal(q.last, 23456);
	assert.equal(q.time, "22:15:00");
	assert.throws(() => parseTaifex({ RtCode: "0", RtData: { QuoteList: [withSpot.RtData.QuoteList[0]] } }, "1"), /沒有台指期/);
});

test("走勢圖屬於哪一盤：交易中＝這一盤；收盤後（清晨、週末）＝剛結束的那一盤", () => {
	const friNight = tapeKey(tpe(2026, 11, 6, 23)); // 週五夜盤
	assert.equal(tapeKey(tpe(2026, 11, 7, 2)), friNight, "跨午夜");
	assert.equal(tapeKey(tpe(2026, 11, 7, 7)), friNight, "清晨 5 點收盤後還是這一盤");
	assert.equal(tapeKey(tpe(2026, 11, 8, 20)), friNight, "週日");
	assert.equal(tapeKey(tpe(2026, 11, 9, 8, 30)), friNight, "週一開盤前");
	const monDay = tapeKey(tpe(2026, 11, 9, 9));
	assert.notEqual(monDay, friNight);
	assert.equal(tapeKey(tpe(2026, 11, 9, 14, 30)), monDay, "日盤收盤後到夜盤開始前");
	assert.notEqual(tapeKey(tpe(2026, 11, 9, 15, 0)), monDay, "夜盤開始就換");
});

test("夜盤的圖到早上還在；下一盤開始才重來；很久以前留下的圖不會冒充上一盤", () => {
	const { app } = makeApp();
	const tape = new TxfTape(app);
	const q = (last: number, time: string, market: "0" | "1" = "1") => ({ name: "臺指期11", last, ref: 100, high: null, low: null, time, market });
	tape.add(q(101, "23:00:00"), tpe(2026, 11, 6, 23));
	tape.add(q(103, "04:59:58"), tpe(2026, 11, 7, 4, 59));
	assert.equal(tape.points.length, 2);
	// 週六早上 7 點再打開：圖還在，而且收盤中不加點
	const sat = new TxfTape(app);
	assert.equal(sat.add(q(103, "04:59:58"), tpe(2026, 11, 7, 7)).length, 2);
	assert.equal(sat.add(q(103, "04:59:58"), tpe(2026, 11, 8, 12)).length, 2, "週日也還在");
	// 週一日盤開始：重來
	assert.deepEqual(
		sat.add(q(105, "08:45:01", "0"), tpe(2026, 11, 9, 8, 46)).map((p) => p.v),
		[105],
	);
	// 週三才再打開（收盤中）：週一留下的圖不是「上一盤」，要清掉
	const wed = new TxfTape(app);
	assert.equal(wed.add(q(110, "13:44:59", "0"), tpe(2026, 11, 11, 14)).length, 0);
});

test("期交所沒給成交時間時，只看價格有沒有變", () => {
	const { app } = makeApp();
	const tape = new TxfTape(app);
	const q = (last: number) => ({ name: "臺指期11", last, ref: 100, high: null, low: null, time: "", market: "1" as const });
	const t0 = tpe(2026, 11, 6, 22);
	tape.add(q(101), t0);
	tape.add(q(101), t0 + 30);
	tape.add(q(102), t0 + 60);
	assert.deepEqual(
		tape.points.map((p) => p.v),
		[101, 102],
	);
});

test("最後成交是幾分鐘前；國定假日（時鐘說在交易、很久沒成交）當作休市", () => {
	assert.equal(tradeAgeMin("09:59:00", tpe(2026, 11, 6, 10, 0)), 1);
	assert.ok(Math.abs(tradeAgeMin("23:59:30", tpe(2026, 11, 7, 0, 0))! - 0.5) < 1e-9, "跨午夜");
	assert.ok(tradeAgeMin("10:00:30", tpe(2026, 11, 6, 10, 0))! < 0, "裝置時鐘慢一點：接近 0，不是一整天");
	assert.equal(tradeAgeMin("", 0), null);
	assert.equal(tradeAgeMin("abc", 0), null);
	const q = (time: string) => ({ name: "", last: 1, ref: 1, high: null, low: null, time, market: "0" as const });
	assert.equal(txfHalted(q("09:59:50"), tpe(2026, 11, 6, 10, 0)), false);
	assert.equal(txfHalted(q("04:59:58"), tpe(2026, 11, 6, 10, 0)), true, "平日 10 點，最後成交是清晨 → 休市");
	assert.equal(txfHalted(q("04:59:58"), tpe(2026, 11, 6, 20, 0)), true, "夜盤時間也一樣");
	assert.equal(txfHalted(q("04:59:58"), tpe(2026, 11, 7, 10, 0)), false, "週末本來就收盤，不另外標休市");
	assert.equal(txfHalted(q(""), tpe(2026, 11, 6, 10, 0)), false, "沒有成交時間就不猜");
});
