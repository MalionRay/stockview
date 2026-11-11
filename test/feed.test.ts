import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Alarms } from "../src/alarms";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/config";
import { Feed, MAX_BACKOFF, pool } from "../src/feed";
import { Ratings } from "../src/ratings";
import { makeApp } from "./helpers/app";
import { chart, note } from "./fixtures";
const ob = require("obsidian");

function setup(files: [string, string][], opts: { viewOpen?: boolean; settings?: Partial<typeof DEFAULT_SETTINGS> } = {}) {
	const { app } = makeApp(new Map(files));
	const settings = { ...DEFAULT_SETTINGS, ...opts.settings };
	const alarms = new Alarms(app);
	const ratings = new Ratings(app, () => undefined);
	const fired: string[] = [];
	const feed = new Feed({ app, settings, alarms, ratings, viewOpen: () => opts.viewOpen ?? true, onAlarm: (e) => fired.push(...e.map((x) => `${x.ticker}:${x.kind}`)) });
	return { app, feed, fired, settings };
}

test("抓每一檔報價；同一檔只抓一次；有錯的那檔記錯誤", async () => {
	const urls: string[] = [];
	ob.__setRequestHandler(async (r: { url: string }) => {
		urls.push(r.url);
		if (r.url.includes("/ZZZZ?")) return { status: 404, json: {} };
		return { status: 200, json: chart({ price: r.url.includes("/AAA?") ? 210 : 50, bars: [] }) };
	});
	const { feed, fired } = setup([
		["Portfolio/a1.md", note({ ticker: "AAA", shares: 1, cost: 100, low: 150, high: 200 })],
		["Portfolio/a2.md", note({ ticker: "AAA", shares: 1, cost: 100 })],
		["Portfolio/z.md", note({ ticker: "ZZZZ", shares: 1 })],
	]);
	const ev = await feed.round();
	assert.equal(urls.filter((u) => u.includes("/AAA?")).length, 1);
	assert.equal(feed.quotes.get("AAA")?.price, 210);
	assert.match(feed.errors.get("ZZZZ")!, /找不到/);
	assert.deepEqual(fired, ["AAA:high"]);
	assert.equal(ev.length, 1);
	const rows = feed.rows();
	assert.equal(rows.find((r) => r.h.ticker === "AAA")?.value, 420);
	// 下一輪同價位不重響
	await feed.round();
	assert.deepEqual(fired, ["AAA:high"]);
});

test("429：間隔加倍，最多 5 分鐘；恢復後回到正常", async () => {
	let busy = true;
	ob.__setRequestHandler(async () => (busy ? { status: 429, json: {} } : { status: 200, json: chart({}) }));
	const { feed } = setup([["Portfolio/a.md", note({ ticker: "AAA", shares: 1 })]]);
	await feed.round();
	assert.equal(feed.backoff, 30_000);
	assert.match(feed.status, /太頻繁/);
	for (let i = 0; i < 10; i++) await feed.round();
	assert.equal(feed.backoff, MAX_BACKOFF);
	assert.equal(feed.intervalMs(), MAX_BACKOFF);
	busy = false;
	await feed.round();
	assert.equal(feed.backoff, 0);
	assert.equal(feed.status, "");
});

test("更新間隔：開著的儀表板 5 秒／收盤 60 秒；背景 30 秒／5 分鐘", async () => {
	const files: [string, string][] = [["Portfolio/a.md", note({ ticker: "AAA", shares: 1, high: 999 })]];
	// 現在時間遠在假資料的交易時段之後＝收盤
	ob.__setRequestHandler(async () => ({ status: 200, json: chart({}) }));
	const open = setup(files, { viewOpen: true });
	assert.equal(open.feed.intervalMs(), 5000, "還沒有報價當作開盤");
	await open.feed.round();
	assert.equal(open.feed.intervalMs(), 60_000);
	const bg = setup(files, { viewOpen: false });
	await bg.feed.round();
	assert.equal(bg.feed.intervalMs(), 300_000);
	assert.equal(bg.feed.shouldRun(), true, "有警示線就在背景跑");
	const noLines = setup([["Portfolio/a.md", note({ ticker: "AAA", shares: 1 })]], { viewOpen: false });
	noLines.feed.reload();
	assert.equal(noLines.feed.shouldRun(), false);
	const off = setup(files, { viewOpen: false, settings: { backgroundAlarm: false } });
	off.feed.reload();
	assert.equal(off.feed.shouldRun(), false);
});

test("匯率：總計用台幣或有台股才抓，10 分鐘一次", async () => {
	const urls: string[] = [];
	ob.__setRequestHandler(async (r: { url: string }) => {
		urls.push(r.url);
		if (r.url.includes("TWD%3DX")) return { status: 200, json: chart({ price: 31.5, currency: "TWD" }) };
		return { status: 200, json: chart({ price: 10 }) };
	});
	const usd = setup([["Portfolio/a.md", note({ ticker: "AAA", shares: 1 })]]);
	await usd.feed.round();
	assert.equal(urls.some((u) => u.includes("TWD%3DX")), false);
	const twd = setup([["Portfolio/a.md", note({ ticker: "AAA", shares: 1 })]], { settings: { base: "TWD" } });
	await twd.feed.round(() => 1_000_000);
	assert.equal(twd.feed.fx, 31.5);
	const n = urls.filter((u) => u.includes("TWD%3DX")).length;
	await twd.feed.round(() => 1_000_000 + 60_000);
	assert.equal(urls.filter((u) => u.includes("TWD%3DX")).length, n);
});

test("關掉警示就不檢查", async () => {
	ob.__setRequestHandler(async () => ({ status: 200, json: chart({ price: 500 }) }));
	const { feed, fired } = setup([["Portfolio/a.md", note({ ticker: "AAA", shares: 1, high: 100 })]], { settings: { alarmEnabled: false } });
	await feed.round();
	assert.deepEqual(fired, []);
});

test("pool 限制同時數量", async () => {
	let active = 0;
	let peak = 0;
	await pool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 5));
		active--;
	});
	assert.equal(peak, 3);
});

test("設定清理：範圍、型別、資料夾", () => {
	const s = sanitizeSettings({ refreshSec: 1, closedRefreshSec: "x" as unknown as number, base: "EUR" as "USD", folder: "/Stocks/", alarmBufferPct: 50, apiKey: "nope" } as never);
	assert.equal(s.refreshSec, 3);
	assert.equal(s.closedRefreshSec, 60);
	assert.equal(s.base, "USD");
	assert.equal(s.folder, "Stocks");
	assert.equal(s.alarmBufferPct, 20);
	assert.equal((s as unknown as Record<string, unknown>).apiKey, undefined, "不認得的欄位（例如金鑰）不會寫進 data.json");
});

// ---- v0.6.0：檢查後修正的問題 ----
import { NOT_FOUND_RETRY, withTimeout } from "../src/feed";
import { QuoteError } from "../src/quote";

function setup2(files: [string, string][], host: { viewOpen?: boolean; viewVisible?: boolean; settings?: Partial<typeof DEFAULT_SETTINGS> }, fetcher?: (t: string) => Promise<any>, timeoutMs?: number) {
	const { app } = makeApp(new Map(files));
	const settings = { ...DEFAULT_SETTINGS, ...host.settings };
	const alarms = new Alarms(app);
	const ratings = new Ratings(app, () => undefined);
	const feed = new Feed(
		{ app, settings, alarms, ratings, viewOpen: () => host.viewOpen ?? true, viewVisible: host.viewVisible === undefined ? undefined : () => host.viewVisible!, onAlarm: () => undefined },
		fetcher,
		timeoutMs,
	);
	return { feed, host };
}
const closedQuote = (price = 10) => ({ price, prevClose: price, currency: "USD", name: "", session: "closed", ext: null, at: 0 });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("打錯的代號（404）不會讓更新卡在開盤的頻率，也不會每一輪都重問；按重新整理才馬上重試", async () => {
	const calls: string[] = [];
	const { feed } = setup2(
		[
			["Portfolio/a.md", note({ ticker: "AAA", shares: 1 })],
			["Portfolio/z.md", note({ ticker: "ZZZZ", shares: 1 })],
		],
		{},
		async (t) => {
			calls.push(t);
			if (t === "ZZZZ") throw new QuoteError("找不到這個代號", 404);
			return closedQuote();
		},
	);
	let now = 1_000_000;
	await feed.round(() => now);
	assert.equal(feed.marketOpen(), false, "AAA 收盤、ZZZZ 查不到 → 用收盤的頻率");
	assert.equal(feed.intervalMs(), 60_000);
	assert.equal(feed.status, "", "查不到代號不是「連不到網路」");
	now += 60_000;
	await feed.round(() => now);
	assert.deepEqual(calls, ["AAA", "ZZZZ", "AAA"], "10 分鐘內不再問 ZZZZ");
	assert.match(feed.errors.get("ZZZZ")!, /找不到/, "錯誤訊息還在");
	now += NOT_FOUND_RETRY;
	await feed.round(() => now);
	assert.equal(calls.filter((t) => t === "ZZZZ").length, 2, "過 10 分鐘再試一次");
	feed.refreshNow();
	await feed.round(() => now + 1000);
	assert.equal(calls.filter((t) => t === "ZZZZ").length, 3, "按重新整理馬上重試");
});

test("只有格式錯誤、沒有連線錯誤時不顯示「連不到網路」；全部連不上才顯示", async () => {
	let mode: "data" | "net" = "data";
	const { feed } = setup2([["Portfolio/a.md", note({ ticker: "AAA", shares: 1 })]], {}, async () => {
		throw mode === "data" ? new QuoteError("查無資料") : new QuoteError("連不到 Yahoo", undefined, true);
	});
	await feed.round();
	assert.equal(feed.status, "");
	mode = "net";
	await feed.round();
	assert.match(feed.status, /連不到網路/);
	assert.equal(feed.marketOpen(), false, "全部抓不到時不用開盤的頻率猛試");
});

test("請求卡住：逾時後這一輪照樣結束，下一輪還能跑", async () => {
	let n = 0;
	const { feed } = setup2([["Portfolio/a.md", note({ ticker: "AAA", shares: 1 })]], {}, () => (n++ === 0 ? new Promise(() => undefined) : Promise.resolve(closedQuote(7))), 30);
	await feed.round();
	assert.match(feed.errors.get("AAA")!, /逾時/);
	assert.match(feed.status, /連不到網路/);
	await feed.round();
	assert.equal(feed.quotes.get("AAA")?.price, 7);
	await assert.rejects(withTimeout(new Promise(() => undefined), 10), /逾時/);
	assert.equal(await withTimeout(Promise.resolve(5), 10), 5);
});

test("儀表板開著但看不到（別的分頁、Obsidian 在背景）：用背景的頻率", async () => {
	const files: [string, string][] = [["Portfolio/a.md", note({ ticker: "AAA", shares: 1 })]];
	const hidden = setup2(files, { viewOpen: true, viewVisible: false }, async () => ({ ...closedQuote(), session: "regular" }));
	await hidden.feed.round();
	assert.equal(hidden.feed.shouldRun(), true, "開著就繼續抓（只是慢一點）");
	assert.equal(hidden.feed.intervalMs(), 30_000);
	hidden.host.viewVisible = true;
	assert.equal(hidden.feed.intervalMs(), 5000);
});

test("更新到一半又被要求更新（剛新增股票）：這一輪結束後馬上再抓一次", async () => {
	let release: (() => void) | null = null;
	let calls = 0;
	const { feed } = setup2([["Portfolio/a.md", note({ ticker: "AAA", shares: 1 })]], { settings: { closedRefreshSec: 3600 } }, async () => {
		calls++;
		if (calls === 1) await new Promise<void>((r) => (release = r));
		return closedQuote();
	});
	feed.start();
	await wait(20);
	assert.equal(calls, 1, "第一輪進行中");
	feed.kick();
	feed.kick();
	await wait(20);
	assert.equal(calls, 1, "進行中不會同時再抓");
	release!();
	await wait(40);
	assert.equal(calls, 2, "結束後馬上補一輪（不用等 1 小時）");
	await wait(40);
	assert.equal(calls, 2, "只補一輪");
	feed.stop();
});

test("啟動時儀表板沒開、有警示線：馬上開始背景檢查（不用等 5 分鐘）", async () => {
	let calls = 0;
	const { feed } = setup2([["Portfolio/a.md", note({ ticker: "AAA", shares: 1, high: 999 })]], { viewOpen: false }, async () => (calls++, closedQuote()));
	feed.start();
	await wait(30);
	feed.stop();
	assert.equal(calls, 1);
});
