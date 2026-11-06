// 警示音：Web Audio 嗶兩聲（不用音檔）。iOS 要在點擊事件裡先 unlockAudio() 才能出聲。
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
	if (ctx) return ctx;
	const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!AC) return null;
	try {
		ctx = new AC();
	} catch {
		ctx = null;
	}
	return ctx;
}

/** 在使用者點擊時呼叫（iOS 自動播放限制）。 */
export function unlockAudio(): void {
	const c = context();
	if (c && c.state === "suspended") void c.resume().catch(() => undefined);
}

export function beep(kind: "high" | "low"): void {
	const c = context();
	if (!c) return;
	try {
		if (c.state === "suspended") void c.resume().catch(() => undefined);
		// 突破上限：由低到高；跌破下限：由高到低
		const notes = kind === "high" ? [660, 990] : [990, 520];
		notes.forEach((f, i) => {
			const o = c.createOscillator();
			const g = c.createGain();
			o.type = "sine";
			o.frequency.value = f;
			const t = c.currentTime + i * 0.22;
			g.gain.setValueAtTime(0.0001, t);
			g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
			g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
			o.connect(g).connect(c.destination);
			o.start(t);
			o.stop(t + 0.21);
		});
	} catch {
		// 沒聲音就算了，畫面上的通知還在
	}
}
