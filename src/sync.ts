// 觸發 Remotely Save 同步（非正式內部 API：app.commands.executeCommandById 與它內部的 isSyncing，可能隨版本失效，失效時就只靠它自己的定時同步）。
// - 新增／編輯／刪除股票後 2 秒：把筆記送上去
// - 打開儀表板、按重新整理：把別台裝置的改動拉下來
// 不在「筆記被改」時觸發：同步下載的檔案也會觸發筆記事件，會變成多同步一次。
import type { App } from "obsidian";

export const REMOTELY_SAVE_SYNC = "remotely-save:start-sync";
const WAIT_MAX = 60_000;

interface Commands {
	commands?: Record<string, unknown>;
	executeCommandById?: (id: string) => boolean;
}

export class SyncTrigger {
	lastAt = 0;
	private timer: number | null = null;

	constructor(
		private app: App,
		private enabled: () => boolean,
		private sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms)),
	) {}

	private cmds(): Commands | undefined {
		return (this.app as unknown as { commands?: Commands }).commands;
	}

	private syncing(): boolean {
		const rs = (this.app as unknown as { plugins?: { plugins?: Record<string, { isSyncing?: boolean }> } }).plugins?.plugins?.["remotely-save"];
		return rs?.isSyncing === true;
	}

	available(): boolean {
		const c = this.cmds();
		return !!c?.executeCommandById && !!c.commands?.[REMOTELY_SAVE_SYNC];
	}

	/** 馬上同步；距離上次不到 minGapMs 就略過。正在同步時先等它結束（它可能沒包含剛改的筆記）。 */
	async now(minGapMs = 0): Promise<boolean> {
		if (!this.enabled() || !this.available()) return false;
		if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
		if (minGapMs && Date.now() - this.lastAt < minGapMs) return false;
		this.lastAt = Date.now();
		const started = Date.now();
		while (this.syncing() && Date.now() - started < WAIT_MAX) await this.sleep(500);
		try {
			return this.cmds()!.executeCommandById!(REMOTELY_SAVE_SYNC);
		} catch (e) {
			console.error("StockView sync", e);
			return false;
		}
	}

	/** 改了筆記後過一下再同步（連續改好幾檔只同步一次）。 */
	soon(delayMs = 2000): void {
		if (!this.enabled()) return;
		this.cancel();
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.now();
		}, delayMs);
	}

	cancel(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
	}
}
