// v0.7.0：投資金額與現金（整個帳戶一組）、總資產、總盈虧、「全部」的各清單小計。數字都是編的。
import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_FILE, Account, accountNote, accountPath, accountSummary, checkAccount, hasAccount, readAccount, saveAccount, share } from "../src/account";
import { Alarms } from "../src/alarms";
import { DEFAULT_SETTINGS, LS_LIST } from "../src/config";
import { Feed } from "../src/feed";
import { readHoldings, visibleLists, readLists } from "../src/holdings";
import { AccountModal } from "../src/modals";
import { Ratings } from "../src/ratings";
import { DashboardView } from "../src/view";
import StockViewPlugin from "../src/main";
import { makeApp } from "./helpers/app";
import { chart, note } from "./fixtures";
const ob = require("obsidian");

const acct = (o: Partial<Account> = {}): Account => ({ invested: null, cash: null, currency: "USD", exists: true, ...o });
const text = (el: Element | null) => el?.textContent ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 讀寫「帳戶.md」 ----------
test("帳戶.md：沒有就是沒設定；有就讀投資金額、現金、幣別（沒寫幣別用總計幣別）", () => {
	const { app } = makeApp(new Map([["Portfolio/NVDA.md", note({ ticker: "NVDA", shares: 1 })]]));
	assert.deepEqual(readAccount(app, "Portfolio", "TWD"), { invested: null, cash: null, currency: "TWD", exists: false });
	assert.equal(accountPath("Portfolio/"), `Portfolio/${ACCOUNT_FILE}`);
	const read = (fm: Record<string, string | number>) => readAccount(makeApp(new Map([["Portfolio/帳戶.md", note(fm)]])).app, "Portfolio", "USD");
	assert.deepEqual(read({ invested: 25000, cash: 2100, currency: "USD" }), { invested: 25000, cash: 2100, currency: "USD", exists: true });
	assert.deepEqual(read({ invested: '"25,000"', cash: "", currency: "twd" }), { invested: 25000, cash: null, currency: "TWD", exists: true });
	assert.deepEqual(read({ invested: "abc", cash: "-50" }), { invested: null, cash: -50, currency: "USD", exists: true }, "現金可以是負的（融資）");
});

test("存帳戶：沒有就建立（含說明）；已經有就只改 frontmatter，內文不動", async () => {
	const { app, files } = makeApp();
	await saveAccount(app, "Portfolio", { invested: 25000, cash: null, currency: "USD" });
	const s = String(files.get("Portfolio/帳戶.md"));
	assert.equal(s, accountNote({ invested: 25000, cash: null, currency: "USD" }));
	assert.match(s, /^---\ninvested: 25000\ncash: \ncurrency: USD\n---\n# 帳戶\n/);
	assert.match(s, /總資產＝股票市值＋現金；總盈虧＝總資產 − 投資金額/);
	assert.deepEqual(readAccount(app, "Portfolio", "TWD"), { invested: 25000, cash: null, currency: "USD", exists: true });

	files.set("Portfolio/帳戶.md", s + "\n我自己的筆記：12 月加碼\n");
	await saveAccount(app, "Portfolio", { invested: 30000, cash: 1200, currency: "TWD" });
	assert.deepEqual(readAccount(app, "Portfolio", "USD"), { invested: 30000, cash: 1200, currency: "TWD", exists: true });
	assert.match(String(files.get("Portfolio/帳戶.md")), /我自己的筆記：12 月加碼/);

	await saveAccount(app, "Portfolio", { invested: null, cash: null, currency: "TWD" });
	assert.equal(hasAccount(readAccount(app, "Portfolio", "USD")), false, "兩個都清空＝不顯示");
});

test("輸入檢查：投資金額不能是負的；現金可以是負的", () => {
	assert.equal(checkAccount({ invested: -1, cash: null, currency: "USD" }), "投資金額要是 0 以上的數字");
	assert.equal(checkAccount({ invested: null, cash: NaN, currency: "USD" }), "現金要是數字");
	assert.equal(checkAccount({ invested: 0, cash: -300, currency: "USD" }), null);
	assert.equal(checkAccount({ invested: null, cash: null, currency: "USD" }), null);
});

test("帳戶.md 不是股票：不會出現在表格裡，也不會讓空的主清單出現", () => {
	const { app } = makeApp(
		new Map([
			["Portfolio/帳戶.md", accountNote({ invested: 100, cash: 5, currency: "USD" })],
			["Portfolio/長期/AAA.md", note({ ticker: "AAA", shares: 1 })],
			["Portfolio/短線/BBB.md", note({ ticker: "BBB", shares: 1 })],
		]),
	);
	const hs = readHoldings(app, "Portfolio");
	assert.deepEqual(hs.map((h) => h.ticker).sort(), ["AAA", "BBB"]);
	assert.deepEqual(visibleLists(readLists(app, "Portfolio", hs), hs), ["短線", "長期"].sort((a, b) => a.localeCompare(b, "zh-Hant")));
});

// ---------- 計算 ----------
test("總資產＝市值＋現金；總盈虧＝總資產 − 投資金額", () => {
	const t = { value: 1500, cost: 900 };
	assert.equal(accountSummary(acct(), t, "USD", null), null, "沒填就不算");
	assert.equal(accountSummary(null, t, "USD", null), null);
	assert.deepEqual(accountSummary(acct({ invested: 1500, cash: 300 }), t, "USD", null), {
		invested: 1500,
		cash: 300,
		cashEstimated: false,
		assets: 1800,
		pl: 300,
		plPct: 20,
		needsFx: false,
	});
	// 現金沒填：用投資金額 − 持股成本估算 → 總盈虧就等於未實現損益
	const est = accountSummary(acct({ invested: 1500 }), t, "USD", null)!;
	assert.deepEqual({ cash: est.cash, est: est.cashEstimated, assets: est.assets, pl: est.pl }, { cash: 600, est: true, assets: 2100, pl: 600 });
	// 只填現金：有總資產，算不出總盈虧
	const cashOnly = accountSummary(acct({ cash: 200 }), t, "USD", null)!;
	assert.deepEqual({ assets: cashOnly.assets, pl: cashOnly.pl, pct: cashOnly.plPct }, { assets: 1700, pl: null, pct: null });
	// 投資金額 0：算得出金額，百分比算不出來
	assert.equal(accountSummary(acct({ invested: 0, cash: 0 }), t, "USD", null)!.plPct, null);
});

test("幣別不同時換算：台幣的投資金額、現金換成美元總計（匯率還沒抓到用 32）", () => {
	const a = acct({ invested: 48000, cash: 6400, currency: "TWD" });
	const s = accountSummary(a, { value: 1500, cost: 900 }, "USD", 32)!;
	assert.deepEqual({ invested: s.invested, cash: s.cash, assets: s.assets, pl: s.pl, fx: s.needsFx }, { invested: 1500, cash: 200, assets: 1700, pl: 200, fx: true });
	assert.equal(accountSummary(a, { value: 1500, cost: 900 }, "USD", null)!.invested, 1500, "沒有匯率用暫用的 32");
	const twd = accountSummary(acct({ invested: 1000, cash: 100, currency: "USD" }), { value: 32000, cost: 0 }, "TWD", 30)!;
	assert.deepEqual({ invested: twd.invested, cash: twd.cash, assets: twd.assets }, { invested: 30000, cash: 3000, assets: 35000 });
	assert.equal(share(300, 1800)!.toFixed(1), "16.7");
	assert.equal(share(5, 0), null);
	assert.equal(share(null, 10), null);
});

test("報價：投資金額用台幣、總計用美元、只有美股時也會抓匯率", async () => {
	const calls: string[] = [];
	const make = (files: [string, string][]) => {
		const { app } = makeApp(new Map(files));
		const settings = { ...DEFAULT_SETTINGS };
		return new Feed(
			{ app, settings, alarms: new Alarms(app), ratings: new Ratings(app, () => undefined), viewOpen: () => true, onAlarm: () => undefined },
			async (t: string) => (calls.push(t), { price: t === "TWD=X" ? 32 : 10, prevClose: 10, currency: "USD", name: "", session: "closed", ext: null, at: 0 }),
		);
	};
	const a = make([["Portfolio/AAA.md", note({ ticker: "AAA", shares: 1 })]]);
	await a.round();
	assert.ok(!calls.includes("TWD=X"), "沒有帳戶：只有美股不用匯率");
	const b = make([
		["Portfolio/AAA.md", note({ ticker: "AAA", shares: 1 })],
		["Portfolio/帳戶.md", accountNote({ invested: 48000, cash: null, currency: "TWD" })],
	]);
	await b.round();
	assert.ok(calls.includes("TWD=X"));
	assert.equal(b.fx, 32);
	assert.deepEqual(b.account, { invested: 48000, cash: null, currency: "TWD", exists: true });
});

// ---------- 畫面 ----------
async function mount(files: [string, string][], prices: Record<string, [number, number]> = {}) {
	const { app, ls } = makeApp(new Map(files));
	const settings = { ...DEFAULT_SETTINGS };
	const alarms = new Alarms(app);
	const plugin: any = { app, settings, alarms, opened: [] as string[] };
	plugin.ratings = new Ratings(app, () => plugin.feed.emit());
	plugin.feed = new Feed({ app, settings, alarms, ratings: plugin.ratings, viewOpen: () => true, onAlarm: () => undefined });
	for (const k of ["selectedList", "selectList", "defaultAddList"]) plugin[k] = (StockViewPlugin.prototype as any)[k].bind(plugin);
	for (const k of ["openHoldingModal", "openListModal", "openDeleteListModal", "openMoveModal", "openDeleteModal", "openNote", "openSettings"]) plugin[k] = () => plugin.opened.push(k);
	plugin.openAccountModal = () => plugin.opened.push("account");
	plugin.sync = { now: async () => true, soon: () => undefined };
	ob.__setRequestHandler(async (r: { url: string }) => {
		const t = decodeURIComponent(r.url.split("/chart/")[1]?.split("?")[0] ?? "");
		const [price, prev] = prices[t] ?? [100, 100];
		return { status: 200, json: chart({ price, prev, currency: t === "TWD=X" ? "TWD" : "USD" }) };
	});
	const view = new DashboardView({ app } as never, plugin);
	await view.onOpen();
	return { view, plugin, el: view.contentEl, ls };
}
const cards = (el: HTMLElement) => [...el.querySelectorAll(".sv-card")].map(text);
const breakRows = (el: HTMLElement) => [...el.querySelectorAll(".sv-break tbody tr")].map(text);

test("只有一個清單：填了帳戶就顯示總資產、總盈虧、今日損益、現金、總市值、未實現損益；點總盈虧或現金可以修改", async () => {
	const { el, plugin } = await mount(
		[
			["Portfolio/AAA.md", note({ ticker: "AAA", shares: 10, cost: 50 })],
			["Portfolio/BBB.md", note({ ticker: "BBB", shares: 5, cost: 80 })],
			["Portfolio/帳戶.md", accountNote({ invested: 1500, cash: 300, currency: "USD" })],
		],
		{ AAA: [100, 90], BBB: [100, 100] },
	);
	// 報價還沒回來：總資產、總盈虧先不顯示
	plugin.feed.reload();
	plugin.feed.emit();
	assert.match(cards(el)[0], /總資產—讀取中…/);
	assert.match(cards(el)[1], /總盈虧—讀取中…/);

	await plugin.feed.round();
	const c = cards(el);
	assert.equal(c.length, 6);
	assert.equal(c[0], "總資產$1,800.00股票 83.3%・現金 16.7%");
	assert.equal(c[1], "總盈虧+$300.00+20.00%・投入 $1,500.00");
	assert.match(c[2], /^今日損益\+\$100\.00/);
	assert.equal(c[3], "現金$300.00");
	assert.equal(c[4], "總市值$1,500.002 檔持股");
	assert.equal(c[5], "未實現損益+$600.00+66.67%・成本 $900.00");
	assert.equal(el.querySelector(".sv-break")?.querySelector("table"), null, "只有一個清單：沒有各清單小計");
	const editable = [...el.querySelectorAll(".sv-card-edit")].map((x) => text(x.querySelector(".sv-card-label")));
	assert.deepEqual(editable, ["總盈虧", "現金"]);
	(el.querySelectorAll(".sv-card-edit")[1] as HTMLElement).click();
	assert.deepEqual(plugin.opened, ["account"]);
});

test("現金沒填：用投資金額 − 持股成本估算，並標示「估算」；只填現金時總盈虧顯示怎麼補", async () => {
	const files: [string, string][] = [["Portfolio/AAA.md", note({ ticker: "AAA", shares: 10, cost: 50 })]];
	const a = await mount([...files, ["Portfolio/帳戶.md", accountNote({ invested: 800, cash: null, currency: "USD" })]]);
	await a.plugin.feed.round();
	assert.equal(cards(a.el)[3], "現金$300.00估算：投資金額 − 持股成本");
	assert.equal(cards(a.el)[1], "總盈虧+$500.00+62.50%・投入 $800.00");
	const b = await mount([...files, ["Portfolio/帳戶.md", accountNote({ invested: null, cash: 250, currency: "USD" })]]);
	await b.plugin.feed.round();
	assert.equal(cards(b.el)[0], "總資產$1,250.00股票 80.0%・現金 20.0%");
	assert.equal(cards(b.el)[1], "總盈虧—填了投資金額才算得出來");
});

test("多個清單：「全部」有各清單小計（佔總資產、現金、總資產），點一列切到那個清單；單一清單顯示佔總資產多少", async () => {
	const { el, plugin, ls } = await mount(
		[
			["Portfolio/長期/AAA.md", note({ ticker: "AAA", shares: 10, cost: 50 })],
			["Portfolio/短線/BBB.md", note({ ticker: "BBB", shares: 5, cost: 80 })],
			["Portfolio/觀察/CCC.md", note({ ticker: "CCC", shares: "" })],
			["Portfolio/帳戶.md", accountNote({ invested: 1500, cash: 300, currency: "USD" })],
		],
		{ AAA: [100, 90], BBB: [100, 100] },
	);
	await plugin.feed.round();
	assert.match(text(el.querySelector(".sv-list-tab.is-active")), /^全部/);
	assert.equal(cards(el)[0], "總資產$1,800.00股票 83.3%・現金 16.7%");
	assert.deepEqual(
		[...el.querySelectorAll(".sv-break th")].map(text),
		["清單", "市值", "未實現損益", "今日損益", "佔總資產"],
	);
	assert.deepEqual(breakRows(el), [
		"長期1 檔$1,000.00+$500.00+100.00%+$100.00+11.11%55.6%",
		"短線1 檔$500.00+$100.00+25.00%$0.000.00%27.8%",
		"現金$300.0016.7%",
		"總資產$1,800.00+$600.00+66.67%+$100.00+7.14%100%",
	]);
	const fill = el.querySelector(".sv-break .sv-share-fill") as HTMLElement;
	assert.match(fill.style.width, /^55\.5/);
	(el.querySelector(".sv-break-row") as HTMLElement).click();
	assert.equal(ls.get(LS_LIST), "長期");
	const c = cards(el);
	assert.equal(c.length, 4, "單一清單：這個清單的四張卡片");
	assert.equal(c[0], "總市值$1,000.001 檔持股・佔總資產 55.6%");
	assert.match(c[1], /^未實現損益/);
	assert.equal(el.querySelector(".sv-break table"), null, "單一清單沒有小計表");
	assert.equal(el.querySelector(".sv-card-edit"), null);
});

test("多個清單、沒有填帳戶：小計表佔總市值、最後一列合計；卡片多一張「＋ 設定」", async () => {
	const { el, plugin } = await mount([
		["Portfolio/長期/AAA.md", note({ ticker: "AAA", shares: 3, cost: 50 })],
		["Portfolio/短線/BBB.md", note({ ticker: "BBB", shares: 1, cost: 80 })],
	]);
	await plugin.feed.round();
	assert.deepEqual(
		[...el.querySelectorAll(".sv-break th")].map(text),
		["清單", "市值", "未實現損益", "今日損益", "佔比"],
	);
	assert.deepEqual(breakRows(el), ["長期1 檔$300.00+$150.00+100.00%$0.000.00%75.0%", "短線1 檔$100.00+$20.00+25.00%$0.000.00%25.0%", "合計$400.00+$170.00+73.91%$0.000.00%100%"]);
	const add = el.querySelector(".sv-card-add") as HTMLElement;
	assert.equal(text(add), "投資金額與現金＋ 設定算總資產和總盈虧");
	add.click();
	assert.deepEqual(plugin.opened, ["account"]);
	([...el.querySelectorAll(".sv-list-tab")].find((b) => text(b).startsWith("長期")) as HTMLButtonElement).click();
	assert.equal(cards(el)[0], "總市值$300.001 檔持股・佔全部 75.0%");
	assert.equal(el.querySelector(".sv-card-add"), null, "單一清單不放「＋ 設定」");
});

// ---------- 視窗 ----------
function modalPlugin(files: [string, string][]) {
	const { app, files: store } = makeApp(new Map(files));
	const settings = { ...DEFAULT_SETTINGS };
	const alarms = new Alarms(app);
	const plugin: any = { app, settings, alarms, synced: 0 };
	plugin.ratings = new Ratings(app, () => undefined);
	plugin.feed = new Feed({ app, settings, alarms, ratings: plugin.ratings, viewOpen: () => true, onAlarm: () => undefined }, async () => ({
		price: 100,
		prevClose: 100,
		currency: "USD",
		name: "",
		session: "closed",
		ext: null,
		at: 0,
	}));
	plugin.sync = { soon: () => plugin.synced++ };
	return { app, plugin, store };
}

test("投資金額與現金的視窗：顯示估算、檢查輸入、存成帳戶.md", async () => {
	const { app, plugin, store } = modalPlugin([["Portfolio/AAA.md", note({ ticker: "AAA", shares: 10, cost: 50 })]]);
	await plugin.feed.round();
	const m: any = new AccountModal(app, plugin);
	m.open();
	assert.equal(m.title, "投資金額與現金");
	const el: HTMLElement = m.contentEl;
	const [invested, cash] = [...el.querySelectorAll("input")] as HTMLInputElement[];
	const cur = el.querySelector("select") as HTMLSelectElement;
	const est = () => text(el.querySelector(".sv-account-est"));
	const save = [...el.querySelectorAll("button")].find((b) => text(b) === "儲存") as HTMLButtonElement;
	assert.equal(cur.value, "USD");
	assert.equal(est(), "填了投資金額，現金留空時會自動估算");
	invested.value = "1,200";
	invested.dispatchEvent(new window.Event("input"));
	assert.equal(est(), "現金留空：估算 $700.00（投資金額 − 持股成本 $500.00）");
	cur.value = "TWD";
	cur.dispatchEvent(new window.Event("change"));
	assert.equal(est(), "現金留空：估算 −NT$14,800（投資金額 − 持股成本 NT$16,000）", "成本換成台幣（匯率暫用 32）");
	cur.value = "USD";
	cur.dispatchEvent(new window.Event("change"));
	invested.value = "-5";
	invested.dispatchEvent(new window.Event("input"));
	save.click();
	await sleep(0);
	assert.equal(text(el.querySelector(".sv-modal-msg")), "投資金額要是 0 以上的數字");
	assert.equal(store.has("Portfolio/帳戶.md"), false);

	invested.value = "1200";
	invested.dispatchEvent(new window.Event("input"));
	cash.value = "150";
	cash.dispatchEvent(new window.Event("input"));
	assert.equal(est(), "", "有填現金就不用估算");
	save.click();
	await sleep(10);
	assert.deepEqual(readAccount(app, "Portfolio", "TWD"), { invested: 1200, cash: 150, currency: "USD", exists: true });
	assert.equal(plugin.synced, 1, "存完觸發同步");
	assert.ok(ob.__notices.includes("已更新投資金額與現金"));

	// 再打開：預先填好目前的數字
	plugin.feed.reload();
	const m2: any = new AccountModal(app, plugin);
	m2.open();
	const inputs = [...m2.contentEl.querySelectorAll("input")] as HTMLInputElement[];
	assert.deepEqual(
		inputs.map((i) => i.value),
		["1200", "150"],
	);
});
