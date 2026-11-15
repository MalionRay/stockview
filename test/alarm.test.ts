import "./helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AlarmState, alarmText, checkAlarm, isUpAlarm } from "../src/alarm";
import { Alarms, LS_ALARM_LOG, LS_ALARM_STATE } from "../src/alarms";
import { makeApp } from "./helpers/app";

const cfg = { bufferPct: 1, cooldownMin: 30 };
const h = { ticker: "NVDA", low: 150, high: 200 };
const MIN = 60_000;

/** 依序餵價格，回傳每一步有沒有響。 */
function run(prices: [number, number][], c = cfg, hh = h): string[] {
	let s: AlarmState | undefined;
	const out: string[] = [];
	for (const [t, p] of prices) {
		const r = checkAlarm(s, hh, p, t, c);
		s = r.state;
		out.push(r.events.map((e) => e.kind).join(",") || "-");
	}
	return out;
}

test("突破上限響一次；在線附近震盪不重響", () => {
	assert.deepEqual(run([[0, 190], [1, 201], [2, 199.5], [3, 200.5], [4, 199], [5, 201]]), ["-", "high", "-", "-", "-", "-"]);
});

test("回到緩衝區外（上限 −1%）才重新待命；冷卻過後再突破會響", () => {
	assert.deepEqual(run([[0, 201], [1 * MIN, 197], [40 * MIN, 202]]), ["high", "-", "high"]);
});

test("冷卻時間內再突破不響，冷卻結束還在線外就響", () => {
	assert.deepEqual(run([[0, 201], [1 * MIN, 197], [5 * MIN, 202], [31 * MIN, 202]]), ["high", "-", "-", "high"]);
});

test("跌破下限；緩衝是下限 +1%", () => {
	assert.deepEqual(run([[0, 149], [1 * MIN, 151], [40 * MIN, 149], [41 * MIN, 152], [80 * MIN, 149]]), ["low", "-", "-", "-", "low"]);
});

test("沒設界線、沒有價格都不響；改了界線重新待命", () => {
	assert.deepEqual(run([[0, 1], [1, 1000]], cfg, { ticker: "X", low: null, high: null }), ["-", "-"]);
	let s = checkAlarm(undefined, h, null, 0, cfg).state;
	assert.equal(s.highArmed, true);
	s = checkAlarm(s, h, 205, 0, cfg).state;
	assert.equal(s.highArmed, false);
	const r = checkAlarm(s, { ...h, high: 204 }, 205, 40 * MIN, cfg);
	assert.deepEqual(
		r.events.map((e) => e.line),
		[204],
	);
});

test("Alarms：狀態與紀錄存在 localStorage，重開不重響", () => {
	const { app, ls } = makeApp();
	const a = new Alarms(app);
	const ev = a.check([{ ...h, list: "", price: 210 }], cfg, 1000);
	assert.equal(ev.length, 1);
	assert.match(alarmText(ev[0]), /NVDA 突破上限 200，現價 210/);
	assert.equal(a.waiting([""], "NVDA").high, true);
	assert.ok(ls.get(LS_ALARM_STATE));
	assert.equal((ls.get(LS_ALARM_LOG) as unknown[]).length, 1);
	const b = new Alarms(app);
	assert.equal(b.check([{ ...h, list: "", price: 210 }], cfg, 50 * MIN).length, 0);
	assert.equal(b.log.length, 1);
	b.clearLog();
	assert.equal(new Alarms(app).log.length, 0);
});

test("不同清單各自判斷；同一條線同時響只通知一次；不同線各自通知", () => {
	const { app } = makeApp();
	const a = new Alarms(app);
	const ev = a.check(
		[
			{ list: "", ticker: "NVDA", low: null, high: 200, price: 260 },
			{ list: "觀察", ticker: "NVDA", low: null, high: 200, price: 260 },
			{ list: "AI", ticker: "NVDA", low: null, high: 250, price: 260 },
		],
		cfg,
		1000,
	);
	assert.deepEqual(
		ev.map((e) => `${e.list ?? ""}:${e.line}`),
		[":200", "AI:250"],
	);
	assert.match(alarmText(ev[1]), /（AI）$/);
	assert.equal(a.waiting(["觀察"], "NVDA").high, true, "沒通知的那個清單也記成已響過，不會下一輪再響");
	assert.equal(a.waiting(["別的"], "NVDA").high, false);
});

// ---------- 合理價位（v0.8.0）：由下往上、由上往下穿過都響 ----------
const hf = { ticker: "NVDA", low: null, high: null, fair: 100 };

test("合理價位：第一次只記位置不響；往上穿過、往下穿過都響", () => {
	assert.deepEqual(run([[0, 95], [1 * MIN, 100.5], [40 * MIN, 103], [80 * MIN, 99.5]], cfg, hf), ["-", "fair-up", "-", "fair-down"]);
	assert.deepEqual(run([[0, 120], [1 * MIN, 125]], cfg, hf), ["-", "-"], "一開始就在上方：不響");
	assert.deepEqual(run([[0, 120], [1 * MIN, 100]], cfg, hf), ["-", "fair-down"], "從上方跌到合理價位就響");
	assert.deepEqual(run([[0, 100], [1 * MIN, 100.5], [2 * MIN, 99.5]], cfg, hf), ["-", "-", "-"], "一開始剛好在線上：要先離開 1% 才算在哪一邊");
	assert.deepEqual(run([[0, 100], [1 * MIN, 120], [40 * MIN, 99]], cfg, hf), ["-", "-", "fair-down"]);
});

test("合理價位：在線附近震盪不重響；要先在另一邊超過緩衝區（1%）", () => {
	assert.deepEqual(run([[0, 95], [1 * MIN, 100.2], [40 * MIN, 99.6], [80 * MIN, 100.4], [120 * MIN, 100.8]], cfg, hf), ["-", "fair-up", "-", "-", "-"]);
	// 跌到 1% 以下再漲回來：又是一次往上穿過
	assert.deepEqual(run([[0, 95], [1 * MIN, 100.2], [40 * MIN, 98.5], [80 * MIN, 100.1]], cfg, hf), ["-", "fair-up", "-", "fair-up"]);
});

test("合理價位：和上下限共用冷卻時間；冷卻中沒響的仍待命", () => {
	const all = { ticker: "NVDA", low: 90, high: 110, fair: 100 };
	assert.deepEqual(run([[0, 95], [1 * MIN, 100.5], [5 * MIN, 111], [31 * MIN, 111]], cfg, all), ["-", "fair-up", "-", "high"]);
	assert.deepEqual(run([[0, 105], [1 * MIN, 111], [5 * MIN, 99], [40 * MIN, 99]], cfg, all), ["-", "high", "-", "fair-down"]);
});

test("合理價位：改了就重新記位置（不會馬上響）；關掉或沒填都不響", () => {
	const a = checkAlarm(undefined, hf, 95, 0, cfg);
	const b = checkAlarm(a.state, { ...hf, fair: 90 }, 95, 1 * MIN, cfg);
	assert.deepEqual(b.events, [], "改成 90：現在在上方，不響");
	assert.deepEqual([b.state.fairUp, b.state.fairDown, b.state.fa], [false, true, 90]);
	assert.deepEqual(checkAlarm(b.state, { ...hf, fair: 90 }, 89, 40 * MIN, cfg).events.map((e) => e.kind), ["fair-down"]);
	assert.deepEqual(run([[0, 95], [1 * MIN, 105]], { ...cfg, fair: false }, hf), ["-", "-"], "設定關掉");
	const none = checkAlarm(undefined, { ...hf, fair: null }, 95, 0, cfg).state;
	assert.equal("fairUp" in none || "fa" in none, false, "沒填合理價位：狀態裡不留東西");
	// 舊版存下來的狀態（沒有合理價位的欄位）：第一次只記位置
	const old: AlarmState = { highArmed: true, lowArmed: true, last: null, hi: null, lo: null };
	const r = checkAlarm(old, hf, 105, 0, cfg);
	assert.deepEqual(r.events, []);
	assert.deepEqual([r.state.fairUp, r.state.fairDown], [false, true]);
});

test("合理價位的通知文字、方向；同一條線在好幾個清單只通知一次", () => {
	assert.equal(alarmText({ ticker: "NVDA", kind: "fair-up", line: 100, price: 100.5, at: 0, list: "成長" }), "NVDA 漲過合理價位 100，現價 100.5（成長）");
	assert.equal(alarmText({ ticker: "NVDA", kind: "fair-down", line: 100, price: 99.25, at: 0 }), "NVDA 跌破合理價位 100，現價 99.25");
	assert.deepEqual(["high", "low", "fair-up", "fair-down"].map((k) => isUpAlarm(k as never)), [true, false, true, false]);
	const { app } = makeApp();
	const al = new Alarms(app);
	const items = (price: number) => ["A", "B"].map((list) => ({ list, ticker: "NVDA", low: null, high: null, fair: 100, price }));
	assert.deepEqual(al.check(items(95), cfg, 0), []);
	const out = al.check(items(100.5), cfg, MIN);
	assert.deepEqual(
		out.map((e) => [e.kind, e.list]),
		[["fair-up", "A"]],
	);
	assert.deepEqual(al.check(items(100.6), cfg, 40 * MIN), [], "B 也記成響過了");
});

test("背景檢查：只有合理價位也算有警示線（設定關掉就不算）；報價更新時合理價位會響", async () => {
	const { Feed } = await import("../src/feed");
	const { DEFAULT_SETTINGS } = await import("../src/config");
	const { Ratings } = await import("../src/ratings");
	const { note } = await import("./fixtures");
	const { app } = makeApp(new Map([["Portfolio/觀察/NVDA.md", note({ ticker: "NVDA", shares: 0, fair: 100 })]]));
	const settings = { ...DEFAULT_SETTINGS };
	const fired: string[] = [];
	let price = 95;
	const feed = new Feed(
		{ app, settings, alarms: new Alarms(app), ratings: new Ratings(app, () => undefined), viewOpen: () => true, onAlarm: (ev) => fired.push(...ev.map(alarmText)) },
		async () => ({ price, prevClose: 90, currency: "USD", name: "", session: "regular", ext: null, at: 0 }),
	);
	feed.reload();
	assert.equal(feed.hasAlarmLines(), true);
	settings.alarmFair = false;
	assert.equal(feed.hasAlarmLines(), false);
	settings.alarmFair = true;
	await feed.round();
	price = 101;
	await feed.round();
	assert.deepEqual(fired, ["NVDA 漲過合理價位 100，現價 101（觀察）"]);
});
