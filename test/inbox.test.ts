// v0.9.0：警示訊息——響過的警示留著直到自己刪；鈴鐺、狀態列的未讀數；點通知打開。數字都是編的。
import "./helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AlarmCfg } from "../src/alarm";
import { Alarms, INBOX_MAX, LS_ALARM_LOG } from "../src/alarms";
import { AlarmInboxModal } from "../src/inbox";
import StockViewPlugin from "../src/main";
import { makeApp } from "./helpers/app";
const ob = require("obsidian");

const MIN = 60_000;
const cfg: AlarmCfg = { bufferPct: 1, cooldownMin: 30 };
const text = (el: Element | null) => el?.textContent ?? "";
const fire = (a: Alarms, ticker: string, price: number, at: number, list = "") => a.check([{ list, ticker, low: 100, high: 200, price }], cfg, at);

test("響過的警示存成訊息：有 id、未讀；看過、刪一則、全部刪；重開還在", () => {
	const { app, ls } = makeApp();
	const a = new Alarms(app);
	let changes = 0;
	const off = a.onChange(() => changes++);
	fire(a, "AAA", 210, 1 * MIN);
	fire(a, "BBB", 90, 2 * MIN, "觀察");
	assert.deepEqual(
		a.log.map((e) => [e.ticker, e.kind, e.read]),
		[
			["BBB", "low", false],
			["AAA", "high", false],
		],
		"最新的在前面",
	);
	assert.equal(new Set(a.log.map((e) => e.id)).size, 2);
	assert.equal(a.unread(), 2);
	assert.equal(changes, 2);
	a.markRead();
	assert.equal(a.unread(), 0);
	a.markRead();
	assert.equal(changes, 3, "沒有未讀就不再通知");
	const b = new Alarms(app);
	assert.equal(b.log.length, 2, "重開 Obsidian 還在");
	assert.equal(b.unread(), 0);
	b.remove([b.log[0].id]);
	assert.deepEqual(
		b.log.map((e) => e.ticker),
		["AAA"],
	);
	b.remove(["沒有這則"]);
	b.clearLog();
	assert.deepEqual(ls.get(LS_ALARM_LOG), []);
	off();
	fire(a, "CCC", 250, 3 * MIN);
	assert.equal(changes, 3, "取消之後不再通知");
});

test("訊息留到自己刪：不會因為超過 50 則就不見；最多 300 則，太多才從最舊的刪", () => {
	const { app } = makeApp();
	const a = new Alarms(app);
	for (let i = 0; i < INBOX_MAX + 5; i++) fire(a, `T${i}`, 210, i * MIN);
	assert.equal(a.log.length, INBOX_MAX);
	assert.equal(a.log[0].ticker, `T${INBOX_MAX + 4}`);
	assert.equal(a.log[a.log.length - 1].ticker, "T5");
});

test("舊版的警示紀錄：補上 id、當成看過的訊息；壞掉的略過", () => {
	const { app, ls } = makeApp();
	ls.set(LS_ALARM_LOG, [
		{ ticker: "OLD", kind: "high", line: 200, price: 210, at: 1000 },
		{ ticker: "OLD2", kind: "low", line: 100, price: 90, at: 900, list: "觀察" },
		{ nonsense: true },
		null,
	]);
	const a = new Alarms(app);
	assert.deepEqual(
		a.log.map((e) => [e.ticker, e.read, typeof e.id]),
		[
			["OLD", true, "string"],
			["OLD2", true, "string"],
		],
	);
	assert.equal(a.unread(), 0, "舊紀錄不會讓鈴鐺突然出現一堆未讀");
	a.remove([a.log[1].id]);
	assert.deepEqual(
		new Alarms(app).log.map((e) => e.ticker),
		["OLD"],
	);
});

function inbox() {
	const { app } = makeApp();
	const alarms = new Alarms(app);
	const plugin: any = { app, alarms };
	const m: any = new AlarmInboxModal(app, plugin);
	const rows = () => [...m.contentEl.querySelectorAll(".sv-inbox-item")].map((r: Element) => text(r.querySelector(".sv-inbox-text")));
	const news = () => [...m.contentEl.querySelectorAll(".sv-inbox-item.is-new")].length;
	const btn = (re: RegExp) => [...m.contentEl.querySelectorAll("button")].find((b: Element) => re.test(text(b))) as HTMLButtonElement;
	return { app, alarms, m, rows, news, btn };
}

test("警示訊息視窗：列出每一則、沒看過的標「新」，打開就算看過；可以一則一則刪", () => {
	const { alarms, m, rows, news } = inbox();
	fire(alarms, "AAA", 210, 1 * MIN);
	fire(alarms, "BBB", 90, 2 * MIN, "觀察");
	alarms.markRead();
	fire(alarms, "CCC", 205, 3 * MIN);
	m.open();
	assert.equal(m.title, "警示訊息");
	assert.deepEqual(rows(), ["CCC 突破上限 200，現價 205", "BBB 跌破下限 100，現價 90（觀察）", "AAA 突破上限 200，現價 210"]);
	assert.equal(news(), 1, "只有 CCC 是這次才看到的");
	assert.match(text(m.contentEl.querySelector(".sv-inbox-item")), /新/);
	assert.equal(alarms.unread(), 0, "打開就算看過");
	assert.match(text(m.contentEl), /共 3 則，留到你刪掉為止/);
	const del = m.contentEl.querySelectorAll(".sv-inbox-del")[1] as HTMLButtonElement;
	assert.equal(del.getAttribute("aria-label"), "刪除這則");
	del.click();
	assert.deepEqual(rows(), ["CCC 突破上限 200，現價 205", "AAA 突破上限 200，現價 210"]);
	assert.equal(alarms.log.length, 2);
	assert.equal(news(), 1, "重畫後「新」還在（這次打開才看到的）");
	// 開著的時候又響了：馬上出現、標「新」
	fire(alarms, "DDD", 80, 40 * MIN);
	assert.equal(rows()[0], "DDD 跌破下限 100，現價 80");
	assert.equal(news(), 2);
	assert.equal(alarms.unread(), 0);
	m.close();
	fire(alarms, "EEE", 300, 80 * MIN);
	assert.equal(m.contentEl.querySelectorAll(".sv-inbox-item").length, 0, "關掉之後不再重畫");
	assert.equal(alarms.unread(), 1, "關掉之後響的算沒看過");
});

test("警示訊息視窗：全部刪除要按兩次；沒有訊息時說明會留在這裡", () => {
	const { alarms, m, rows, btn } = inbox();
	m.open();
	assert.match(text(m.contentEl), /沒有警示訊息。.*會留在這裡，直到你刪掉/);
	fire(alarms, "AAA", 210, 1 * MIN);
	fire(alarms, "BBB", 90, 2 * MIN);
	assert.equal(rows().length, 2);
	btn(/全部刪除/).click();
	assert.equal(text(btn(/確定刪除/)), "確定刪除全部 2 則？再按一次");
	assert.equal(alarms.log.length, 2, "按一次還不會刪");
	btn(/確定刪除/).click();
	assert.equal(alarms.log.length, 0);
	assert.match(text(m.contentEl), /沒有警示訊息/);
	m.close();
});

test("跳出來的通知：點一下打開警示訊息；文字有提示", () => {
	const opened: string[] = [];
	const plugin: any = { settings: { alarmSound: false }, openInbox: () => opened.push("inbox") };
	(StockViewPlugin.prototype as any).notify.call(plugin, [{ ticker: "AAA", kind: "fair-up", line: 150, price: 151, at: 0 }]);
	const n = (globalThis as any).__lastNotice;
	assert.equal(n.message, "🔔 AAA 漲過合理價位 150，現價 151（點一下看警示訊息）");
	n.messageEl.click();
	assert.deepEqual(opened, ["inbox"]);
	assert.ok(ob.__notices.includes(n.message));
});
