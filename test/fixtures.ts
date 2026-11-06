// 測試用的假 Yahoo 回應（數字都是編的）
export const DAY = {
	pre: { start: 1000, end: 2000 },
	regular: { start: 2000, end: 3000 },
	post: { start: 3000, end: 4000 },
};

export function chart(o: {
	price?: number;
	prev?: number;
	currency?: string;
	name?: string;
	bars?: [number, number | null][]; // [時間, 收盤價]
	period?: typeof DAY;
}) {
	const bars = o.bars ?? [];
	return {
		chart: {
			result: [
				{
					meta: {
						currency: o.currency ?? "USD",
						regularMarketPrice: o.price ?? 100,
						chartPreviousClose: o.prev ?? 95,
						shortName: o.name ?? "Example Corp",
						currentTradingPeriod: o.period ?? DAY,
					},
					timestamp: bars.map((b) => b[0]),
					indicators: { quote: [{ close: bars.map((b) => b[1]) }] },
				},
			],
			error: null,
		},
	};
}

export function note(fm: Record<string, string | number>): string {
	return "---\n" + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n# note\n";
}
