import { test } from "node:test";
import assert from "node:assert/strict";
import { AlarmState, alarmText, checkAlarm } from "../src/alarm";
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
