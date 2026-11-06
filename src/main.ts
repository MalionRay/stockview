// StockView：美股持股儀表板（即時報價含盤前盤後、損益、估值區間、華爾街評級、價格警示）。桌機與 iPad 都能用。
import { Notice, Platform, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { AlarmEvent, alarmText } from "./alarm";
import { Alarms } from "./alarms";
import { DEFAULT_SETTINGS, StockViewSettings, VIEW_TYPE, sanitizeSettings } from "./config";
import { Feed } from "./feed";
import type { Holding } from "./holdings";
import { DeleteHoldingModal, HoldingModal } from "./modals";
import { Ratings } from "./ratings";
import { FinnhubKeyModal, StockViewSettingTab } from "./settings";
import { beep } from "./sound";
import { SyncTrigger } from "./sync";
import { DashboardView } from "./view";

export default class StockViewPlugin extends Plugin {
	settings: StockViewSettings = { ...DEFAULT_SETTINGS };
	feed!: Feed;
	ratings!: Ratings;
	alarms!: Alarms;
	sync!: SyncTrigger;
	private reloadTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.alarms = new Alarms(this.app);
		this.sync = new SyncTrigger(this.app, () => this.settings.autoSync);
		this.ratings = new Ratings(this.app, () => this.feed.emit());
		this.feed = new Feed({
			app: this.app,
			settings: this.settings,
			alarms: this.alarms,
			ratings: this.ratings,
			viewOpen: () => this.app.workspace.getLeavesOfType(VIEW_TYPE).length > 0,
			onAlarm: (e) => this.notify(e),
		});

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new DashboardView(leaf, this));
		this.addRibbonIcon("line-chart", "StockView", () => void this.openDashboard());
		this.addCommand({ id: "open", name: "打開儀表板", callback: () => void this.openDashboard() });
		this.addCommand({ id: "add", name: "新增股票", callback: () => this.openHoldingModal() });
		this.addCommand({ id: "refresh", name: "重新整理報價", callback: () => this.feed.kick() });
		this.addCommand({ id: "finnhub-key", name: "設定 Finnhub 金鑰", callback: () => new FinnhubKeyModal(this.app, this).open() });
		this.addSettingTab(new StockViewSettingTab(this.app, this));

		// 股票筆記改了：重讀清單（合併成一次）
		const onFile = (path: string) => {
			if (!this.inFolder(path)) return;
			if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
			this.reloadTimer = window.setTimeout(() => {
				this.reloadTimer = null;
				this.feed.reload();
				this.feed.kick();
			}, 500);
		};
		this.registerEvent(this.app.metadataCache.on("changed", (f) => onFile(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => onFile(f.path)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => (onFile(f.path), onFile(old))));

		this.app.workspace.onLayoutReady(() => this.feed.start());
	}

	onunload(): void {
		this.feed?.stop();
		this.sync?.cancel();
		if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
	}

	async loadSettings(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		Object.assign(this.settings, sanitizeSettings(raw));
	}

	async saveSettings(): Promise<void> {
		Object.assign(this.settings, sanitizeSettings(this.settings as unknown as Record<string, unknown>));
		await this.saveData(this.settings);
	}

	inFolder(path: string): boolean {
		const f = normalizePath(this.settings.folder);
		return path.startsWith(f + "/") && path.endsWith(".md");
	}

	async openDashboard(): Promise<void> {
		const ws = this.app.workspace;
		const existing = ws.getLeavesOfType(VIEW_TYPE)[0];
		if (existing) {
			await ws.revealLeaf(existing);
			return;
		}
		const leaf = ws.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		await ws.revealLeaf(leaf);
	}

	openHoldingModal(h?: Holding): void {
		new HoldingModal(this.app, this, h).open();
	}

	openDeleteModal(h: Holding): void {
		new DeleteHoldingModal(this.app, this, h).open();
	}

	async openNote(path: string): Promise<void> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.app.workspace.getLeaf("tab").openFile(f);
	}

	openSettings(): void {
		const s = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		if (!s) return;
		s.open();
		s.openTabById(this.manifest.id);
	}

	/** 警示：Obsidian 通知（點一下才關）＋提示音；桌機另外跳系統通知。 */
	notify(events: AlarmEvent[]): void {
		for (const e of events) {
			new Notice(`🔔 ${alarmText(e)}`, 0);
			if (Platform.isDesktopApp && typeof Notification !== "undefined") {
				try {
					new Notification("StockView", { body: alarmText(e) });
				} catch {
					// 沒有系統通知權限就只顯示 Obsidian 通知
				}
			}
		}
		if (this.settings.alarmSound && events.length) beep(events[0].kind);
	}
}
