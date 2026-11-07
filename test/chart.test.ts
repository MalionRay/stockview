import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { VB_H, VB_W, drawChart, linePath, makeScale, nearestIndex } from "../src/chart";

const pts = [
	{ t: 0, v: 10 },
	{ t: 60, v: 12 },
	{ t: 120, v: 11 },
];

test("座標：依順序平均分布；y 範圍包含基準線", () => {
	const sc = makeScale(pts, 8, null);
	assert.equal(sc.x(0), 0);
	assert.equal(sc.x(2), VB_W);
	assert.equal(sc.yMin, 8);
	assert.equal(sc.yMax, 12);
	assert.ok(sc.y(12) < sc.y(8), "數字大的在上面");
	assert.match(linePath(pts, sc), /^M0\.0,[\d.]+L300\.0,[\d.]+L600\.0,[\d.]+$/);
	assert.equal(nearestIndex(pts, sc, 280), 1);
});

test("1日：x 依交易時段時間（還沒收盤只畫到一半）；一條水平線也畫得出來", () => {
	const sc = makeScale(pts, null, [0, 240]);
	assert.equal(sc.x(2), VB_W / 2);
	const flat = makeScale([{ t: 0, v: 5 }, { t: 1, v: 5 }], 5, null);
	assert.ok(flat.yMax > flat.yMin);
	assert.ok(isFinite(flat.y(5)) && flat.y(5) > 0 && flat.y(5) < VB_H);
});

test("畫圖：線、面積、基準線、標籤；滑過顯示時間、數值、漲跌", () => {
	document.body.innerHTML = "";
	const box = drawChart(document.body, {
		points: pts,
		base: 10,
		domain: null,
		dir: "up",
		fmtValue: (v) => v.toFixed(1),
		fmtTime: (t) => `T${t}`,
		axisStart: "09:30",
		axisEnd: "16:00",
		label: "測試",
	});
	assert.ok(box.classList.contains("sv-up"));
	assert.ok(box.querySelector("path.sv-chart-line"));
	assert.ok(box.querySelector("path.sv-chart-area"));
	assert.ok(box.querySelector("line.sv-chart-base"));
	assert.equal(box.querySelector(".sv-chart-ylab")!.textContent, "12.010.0");
	assert.equal(box.querySelector(".sv-chart-xlab")!.textContent, "09:3016:00");
	const plot = box.querySelector(".sv-chart-plot") as HTMLElement;
	plot.getBoundingClientRect = () => ({ left: 0, width: 600, top: 0, height: 140, right: 600, bottom: 140, x: 0, y: 0, toJSON() {} }) as DOMRect;
	const ev = new (window as any).MouseEvent("pointermove", { clientX: 310 });
	plot.dispatchEvent(ev);
	const tip = box.querySelector(".sv-chart-tip") as HTMLElement;
	assert.equal(tip.style.display, "");
	assert.equal(tip.textContent, "T6012.0 +20.00%");
	plot.dispatchEvent(new (window as any).MouseEvent("pointerleave"));
	assert.equal(tip.style.display, "none");
});
