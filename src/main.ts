// StockView：美股持股儀表板（即時報價含盤前盤後、損益、估值區間、華爾街評級、價格警示）。桌機與 iPad 都能用。
import { Notice, Platform, Plugin, TFile, WorkspaceLeaf, normalizePath } from "obsidian";
import { AlarmEvent, alarmText } from "./alarm";
import { Alarms } from "./alarms";
import { DEFAULT_SETTINGS, LS_LIST, StockViewSettings, VIEW_TYPE, sanitizeSettings } from "./config";
import { Feed } from "./feed";
import { ALL_LISTS, Holding, MAIN_LIST } from "./holdings";
import { DeleteHoldingModal, DeleteListModal, HoldingModal, HoldingModalOpts, ListModal, MoveHoldingModal } from "./modals";
import { Ratings } from "./ratings";
import { FinnhubKeyModal, StockViewSettingTab } from "./settings";
import { beep } from "./sound";
import { SyncTrigger } from "./sync";
import { DashboardView } from "./view";
import { MARKET_VIEW, MarketsView } from "./marketview";

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
		this.registerView(MARKET_VIEW, (leaf: WorkspaceLeaf) => new MarketsView(leaf, this));
		this.addRibbonIcon("line-chart", "StockView", () => void this.openDashboard());
		this.addRibbonIcon("globe", "StockView 市場行情", () => void this.openMarkets());
		this.addCommand({ id: "open", name: "打開儀表板", callback: () => void this.openDashboard() });
		this.addCommand({ id: "markets", name: "打開市場行情", callback: () => void this.openMarkets() });
		this.addCommand({ id: "add", name: "新增股票", callback: () => this.openHoldingModal({ list: this.defaultAddList() }) });
		this.addCommand({ id: "add-list", name: "新增清單", callback: () => this.openListModal() });
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
		await this.openView(VIEW_TYPE);
	}

	async openMarkets(): Promise<void> {
		await this.openView(MARKET_VIEW);
	}

	/** 已經開著就切過去，沒有就開新分頁。 */
	private async openView(type: string): Promise<void> {
		const ws = this.app.workspace;
		const existing = ws.getLeavesOfType(type)[0];
		if (existing) {
			await ws.revealLeaf(existing);
			return;
		}
		const leaf = ws.getLeaf("tab");
		await leaf.setViewState({ type, active: true });
		await ws.revealLeaf(leaf);
	}

	openHoldingModal(opts: HoldingModalOpts = {}): void {
		new HoldingModal(this.app, this, opts).open();
	}

	openDeleteModal(h: Holding): void {
		new DeleteHoldingModal(this.app, this, h).open();
	}

	openMoveModal(h: Holding): void {
		new MoveHoldingModal(this.app, this, h).open();
	}

	openListModal(rename?: string): void {
		new ListModal(this.app, this, rename).open();
	}

	openDeleteListModal(list: string): void {
		new DeleteListModal(this.app, this, list).open();
	}

	/** 這台裝置目前看的清單；不存在就退回「全部」（只有一個清單時就是那個清單）。 */
	selectedList(): string {
		const vis = this.feed.visibleLists();
		const v = this.app.loadLocalStorage(LS_LIST);
		if (typeof v === "string" && (v === ALL_LISTS ? vis.length > 1 : vis.includes(v))) return v;
		return vis.length > 1 ? ALL_LISTS : (vis[0] ?? MAIN_LIST);
	}

	/** null＝回到全部。 */
	selectList(list: string | null): void {
		this.app.saveLocalStorage(LS_LIST, list ?? ALL_LISTS);
		this.feed.reload(); // 剛建立／改名的清單要馬上看得到
		this.feed.emit();
	}

	/** 新增股票預設放的清單：正在看某個清單就放那裡，看「全部」時放第一個清單。 */
	defaultAddList(): string {
		const sel = this.selectedList();
		if (sel !== ALL_LISTS) return sel;
		return this.feed.visibleLists()[0] ?? MAIN_LIST;
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
