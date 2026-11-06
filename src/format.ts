// 數字格式（純函式）。
export function sym(cur: string): string {
	return cur === "USD" ? "$" : cur === "TWD" ? "NT$" : cur + " ";
}

/** 價格：1 以下多留小數。 */
export function price(v: number | null, cur = "USD"): string {
	if (v === null || !isFinite(v)) return "—";
	const d = Math.abs(v) < 1 ? 4 : 2;
	return sym(cur) + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 金額：台幣不留小數。 */
export function money(v: number | null, cur = "USD", signed = false): string {
	if (v === null || !isFinite(v)) return "—";
	const d = cur === "TWD" ? 0 : 2;
	const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
	const sign = v < 0 ? "−" : signed && v > 0 ? "+" : "";
	return sign + sym(cur) + s;
}

export function signedNum(v: number | null, digits = 2): string {
	if (v === null || !isFinite(v)) return "—";
	const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
	return (v < 0 ? "−" : v > 0 ? "+" : "") + s;
}

export function pct(v: number | null, signed = true): string {
	if (v === null || !isFinite(v)) return "—";
	const s = Math.abs(v).toFixed(2) + "%";
	return (v < 0 ? "−" : signed && v > 0 ? "+" : "") + s;
}

export function shares(v: number | null): string {
	if (v === null) return "—";
	return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function dir(v: number | null): "up" | "down" | "flat" {
	return v === null || !isFinite(v) || v === 0 ? "flat" : v > 0 ? "up" : "down";
}

export function clock(ms: number): string {
	if (!ms) return "—";
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function dateTime(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
