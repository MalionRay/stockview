import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LS_RATINGS, Ratings, SECRET_FINNHUB, cleanKey, parseRecommendation, ratingInfo } from "../src/ratings";
import { makeApp } from "./helpers/app";
const ob = require("obsidian");

const rec = (period: string, sb: number, b: number, h: number, s: number, ss: number) => ({ period, strongBuy: sb, buy: b, hold: h, sell: s, strongSell: ss, symbol: "X" });

test("取最新一期", () => {
	const r = parseRecommendation([rec("2026-09-01", 1, 1, 1, 1, 1), rec("2026-11-01", 10, 20, 5, 0, 0), rec("2026-10-01", 0, 0, 9, 0, 0)], 5);
	assert.equal(r?.period, "2026-11-01");
	assert.equal(r?.buy, 20);
	assert.equal(parseRecommendation([]), null);
	assert.equal(parseRecommendation({ error: "x" }), null);
});

test("評級：1＝強力買進 … 5＝強力賣出", () => {
	const at = 0;
	const lab = (sb: number, b: number, h: number, s: number, ss: number) => ratingInfo({ period: "", strongBuy: sb, buy: b, hold: h, sell: s, strongSell: ss, at })?.label;
	assert.equal(lab(10, 0, 0, 0, 0), "強力買進");
	assert.equal(lab(10, 20, 5, 0, 0), "買進");
	assert.equal(lab(0, 2, 10, 2, 0), "持有");
	assert.equal(lab(0, 0, 2, 10, 0), "賣出");
	assert.equal(lab(0, 0, 0, 1, 9), "強力賣出");
	assert.equal(lab(0, 0, 0, 0, 0), undefined);
	assert.equal(ratingInfo({ period: "", strongBuy: 10, buy: 20, hold: 5, sell: 0, strongSell: 0, at })?.total, 35);
});

test("金鑰只留英數字", () => {
	assert.equal(cleanKey(" abc123​\n"), "abc123");
});

test("沒有金鑰不呼叫；有金鑰依序抓、快取；金鑰錯誤就停", async () => {
	const { app, secrets, ls } = makeApp();
	let calls: string[] = [];
	ob.__setRequestHandler(async (r: { url: string }) => {
		calls.push(r.url);
		if (r.url.includes("symbol=BAD")) return { status: 401, json: {} };
		if (r.url.includes("symbol=NONE")) return { status: 200, json: [] };
		return { status: 200, json: [rec("2026-11-01", 5, 5, 0, 0, 0)] };
	});
	let changes = 0;
	const rs = new Ratings(app, () => changes++);
	const nosleep = async () => undefined;
	await rs.refresh(["AAPL"], nosleep);
	assert.equal(calls.length, 0);

	secrets.set(SECRET_FINNHUB, "k123");
	await rs.refresh(["AAPL", "NONE"], nosleep);
	assert.equal(calls.length, 2);
	assert.match(calls[0], /symbol=AAPL&token=k123/);
	assert.equal(rs.get("AAPL")?.strongBuy, 5);
	assert.equal(rs.none("NONE"), true);
	assert.equal(changes, 2);
	assert.ok(ls.get(LS_RATINGS));

	calls = [];
	await rs.refresh(["AAPL", "NONE"], nosleep);
	assert.equal(calls.length, 0, "12 小時內不重抓");
	assert.equal(new Ratings(app, () => undefined).get("AAPL")?.buy, 5, "快取留在 localStorage");

	await rs.refresh(["BAD", "MSFT"], nosleep);
	assert.equal(calls.length, 1, "金鑰錯誤後不再抓下一檔");
	assert.match(rs.lastError, /金鑰/);
	await rs.refresh(["MSFT"], nosleep);
	assert.equal(calls.length, 1, "1 小時內不再試");
});
