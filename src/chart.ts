// 走勢圖：單一序列的折線＋淡色面積＋基準線（昨收／區間起點），十字線與提示框（滑鼠和觸控都可以）。
// 不用外部套件；SVG 用 viewBox 縮放，線寬用 non-scaling-stroke 保持 2px，文字放在 SVG 外面不會被拉長。
import type { Point } from "./markets";

export const VB_W = 600;
export const VB_H = 200;
const PAD_Y = 10;

export interface Scale {
	x: (i: number) => number; // 第 i 點的 x
	xt: ((t: number) => number) | null; // 時間 → x（只有依時間畫的時候）
	y: (v: number) => number;
	yMin: number;
	yMax: number;
}

/**
 * x：有 domain（1日的交易時段）就依時間，否則依點的順序（5日、1月跳過休市的空白）。
 * y 範圍包含基準線和 extra（圖上要畫的價位線）。
 */
export function makeScale(points: Point[], base: number | null, domain: [number, number] | null, extra: number[] = []): Scale {
	let yMin = Infinity;
	let yMax = -Infinity;
	for (const p of points) {
		if (p.v < yMin) yMin = p.v;
		if (p.v > yMax) yMax = p.v;
	}
	for (const v of extra) {
		if (v < yMin) yMin = v;
		if (v > yMax) yMax = v;
	}
	if (base !== null) {
		yMin = Math.min(yMin, base);
		yMax = Math.max(yMax, base);
	}
	if (yMax === yMin) {
		yMax += Math.abs(yMax) * 0.001 || 1;
		yMin -= Math.abs(yMin) * 0.001 || 1;
	}
	const n = points.length;
	const xt = domain ? (t: number) => ((t - domain[0]) / (domain[1] - domain[0])) * VB_W : null;
	const x = xt ? (i: number) => xt(points[i].t) : (i: number) => (n <= 1 ? VB_W / 2 : (i / (n - 1)) * VB_W);
	const y = (v: number) => PAD_Y + (1 - (v - yMin) / (yMax - yMin)) * (VB_H - 2 * PAD_Y);
	return { x, xt, y, yMin, yMax };
}

/** 圖上的價位線（個股走勢圖：估值下限、合理價位、上限、成本）。 */
export interface ChartLevel {
	v: number;
	label: string;
	kind: "low" | "fair" | "high" | "cost";
}

/**
 * 哪些價位線畫在圖裡、哪些只在上緣／下緣標箭頭：離價格範圍太遠的線如果也畫進去，
 * 價格線會被壓扁看不出走勢，所以 y 軸最多往上、往下各多留價格範圍的一半。
 */
export function placeLevels(points: Point[], base: number | null, levels: ChartLevel[]): { inside: ChartLevel[]; above: ChartLevel[]; below: ChartLevel[] } {
	let lo = Infinity;
	let hi = -Infinity;
	for (const v of [...points.map((p) => p.v), ...(base !== null ? [base] : [])]) {
		if (v < lo) lo = v;
		if (v > hi) hi = v;
	}
	const span = hi - lo || Math.abs(hi) * 0.01 || 1;
	const out = { inside: [] as ChartLevel[], above: [] as ChartLevel[], below: [] as ChartLevel[] };
	for (const l of [...levels].sort((a, b) => a.v - b.v)) {
		if (!isFinite(l.v)) continue;
		if (l.v > hi + span / 2) out.above.push(l);
		else if (l.v < lo - span / 2) out.below.push(l);
		else out.inside.push(l);
	}
	return out;
}

export function linePath(points: Point[], sc: Scale): string {
	return points.map((p, i) => `${i ? "L" : "M"}${sc.x(i).toFixed(1)},${sc.y(p.v).toFixed(1)}`).join("");
}

export function areaPath(points: Point[], sc: Scale): string {
	if (!points.length) return "";
	const bottom = VB_H;
	return `${linePath(points, sc)}L${sc.x(points.length - 1).toFixed(1)},${bottom}L${sc.x(0).toFixed(1)},${bottom}Z`;
}

/** 指標位置（0～VB_W）最近的點。 */
export function nearestIndex(points: Point[], sc: Scale, xv: number): number {
	let best = 0;
	let bd = Infinity;
	for (let i = 0; i < points.length; i++) {
		const d = Math.abs(sc.x(i) - xv);
		if (d < bd) {
			bd = d;
			best = i;
		}
	}
	return best;
}

export interface ChartOpts {
	points: Point[];
	base: number | null;
	domain: [number, number] | null;
	dir: "up" | "down" | "flat";
	fmtValue: (v: number) => string;
	fmtTime: (t: number) => string; // 提示框
	axisStart: string;
	axisEnd: string;
	label: string; // 給螢幕閱讀器
	levels?: ChartLevel[]; // 價位虛線（個股走勢圖）
	bands?: [number, number][]; // 淺色底的時間區段（盤前、盤後；只有依時間畫的時候）
}

const SVG = "http://www.w3.org/2000/svg";
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
	const e = document.createElementNS(SVG, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	parent?.appendChild(e);
	return e;
}

export function drawChart(parent: HTMLElement, o: ChartOpts): HTMLElement {
	const box = parent.createDiv(`sv-chart sv-${o.dir}`);
	const body = box.createDiv("sv-chart-body");
	const plot = body.createDiv("sv-chart-plot");
	const lv = placeLevels(o.points, o.base, o.levels ?? []);
	const sc = makeScale(
		o.points,
		o.base,
		o.domain,
		lv.inside.map((l) => l.v),
	);
	const svg = svgEl("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, preserveAspectRatio: "none", role: "img", "aria-label": o.label });
	plot.appendChild(svg);
	if (sc.xt) {
		for (const [a, b] of o.bands ?? []) {
			const x1 = Math.max(0, sc.xt(a));
			const x2 = Math.min(VB_W, sc.xt(b));
			if (x2 > x1) svgEl("rect", { x: x1.toFixed(1), y: 0, width: (x2 - x1).toFixed(1), height: VB_H, class: "sv-chart-band" }, svg);
		}
	}
	// 價位虛線：圖裡的畫線、右邊標名稱；太遠的在上緣／下緣標箭頭
	const labTops: number[] = [];
	for (const l of [...lv.inside].sort((a, b) => b.v - a.v)) {
		const y = sc.y(l.v);
		svgEl("line", { x1: 0, x2: VB_W, y1: y.toFixed(1), y2: y.toFixed(1), class: `sv-chart-lvl sv-lvl-${l.kind}`, "vector-effect": "non-scaling-stroke" }, svg);
		let top = (y / VB_H) * 100;
		const prev = labTops[labTops.length - 1];
		if (prev !== undefined && top - prev < 9) top = prev + 9; // 兩條線很近時名稱往下錯開，不疊在一起
		labTops.push(top);
		const lab = plot.createDiv({ cls: `sv-chart-lvl-lab sv-lvl-${l.kind}`, text: `${l.label} ${o.fmtValue(l.v)}` });
		lab.style.top = `${Math.min(top, 96)}%`;
	}
	if (lv.above.length) plot.createDiv({ cls: "sv-chart-edge is-top", text: lv.above.map((l) => `↑ ${l.label} ${o.fmtValue(l.v)}`).join("　") });
	if (lv.below.length) plot.createDiv({ cls: "sv-chart-edge is-bottom", text: lv.below.map((l) => `↓ ${l.label} ${o.fmtValue(l.v)}`).join("　") });
	if (o.base !== null) {
		const by = sc.y(o.base).toFixed(1);
		svgEl("line", { x1: 0, x2: VB_W, y1: by, y2: by, class: "sv-chart-base", "vector-effect": "non-scaling-stroke" }, svg);
	}
	svgEl("path", { d: areaPath(o.points, sc), class: "sv-chart-area" }, svg);
	svgEl("path", { d: linePath(o.points, sc), class: "sv-chart-line", "vector-effect": "non-scaling-stroke" }, svg);
	const cross = svgEl("line", { x1: 0, x2: 0, y1: 0, y2: VB_H, class: "sv-chart-cross", "vector-effect": "non-scaling-stroke" }, svg);
	cross.style.display = "none";

	// 圓點用 HTML（SVG 被拉伸時圓會變橢圓）
	const lastI = o.points.length - 1;
	const pos = (i: number) => ({ left: (sc.x(i) / VB_W) * 100, top: (sc.y(o.points[i].v) / VB_H) * 100 });
	const end = plot.createDiv("sv-chart-dot sv-chart-end");
	const ep = pos(lastI);
	end.style.left = `${ep.left}%`;
	end.style.top = `${ep.top}%`;
	const hover = plot.createDiv("sv-chart-dot sv-chart-hover");
	hover.style.display = "none";
	const tip = plot.createDiv("sv-chart-tip");
	tip.style.display = "none";

	// 右側：最高、最低；下方：起訖時間
	const yl = body.createDiv("sv-chart-ylab");
	yl.createSpan({ text: o.fmtValue(sc.yMax) });
	yl.createSpan({ text: o.fmtValue(sc.yMin) });
	const xl = box.createDiv("sv-chart-xlab");
	xl.createSpan({ text: o.axisStart });
	xl.createSpan({ text: o.axisEnd });

	const show = (clientX: number) => {
		const r = plot.getBoundingClientRect();
		if (!r.width) return;
		const xv = ((clientX - r.left) / r.width) * VB_W;
		const i = nearestIndex(o.points, sc, xv);
		const p = o.points[i];
		const x = sc.x(i).toFixed(1);
		cross.setAttribute("x1", x);
		cross.setAttribute("x2", x);
		cross.style.display = "";
		const hp = pos(i);
		hover.style.left = `${hp.left}%`;
		hover.style.top = `${hp.top}%`;
		hover.style.display = "";
		tip.empty();
		tip.createDiv({ cls: "sv-chart-tip-t", text: o.fmtTime(p.t) });
		const line = tip.createDiv({ cls: "sv-chart-tip-v", text: o.fmtValue(p.v) });
		if (o.base) {
			const pct = ((p.v - o.base) / o.base) * 100;
			line.createSpan({ cls: "sv-chart-tip-pct", text: ` ${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%` });
		}
		tip.style.display = "";
		tip.toggleClass("is-left", hp.left > 60);
		tip.style.left = `${hp.left}%`;
	};
	const hide = () => {
		cross.style.display = "none";
		hover.style.display = "none";
		tip.style.display = "none";
	};
	plot.addEventListener("pointermove", (e: PointerEvent) => show(e.clientX));
	plot.addEventListener("pointerdown", (e: PointerEvent) => show(e.clientX));
	plot.addEventListener("pointerleave", hide);
	plot.addEventListener("pointercancel", hide);
	return box;
}
