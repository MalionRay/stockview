// 股票與清單的視窗（iPad 上不用開筆記就能改）：新增／編輯／刪除／移到別的清單、新增／改名／刪除清單。
import { App, Modal, Notice, Setting, TFile } from "obsidian";
import {
	Holding,
	HoldingInput,
	MAIN_LIST,
	addHolding,
	checkInput,
	checkListName,
	createList,
	deleteList,
	listLabel,
	moveHolding,
	num,
	renameList,
	updateHolding,
} from "./holdings";
import type StockViewPlugin from "./main";
import * as F from "./format";
import { fetchQuote, normalizeTicker } from "./quote";

function decimalInput(el: HTMLInputElement): void {
	el.setAttribute("inputmode", "decimal");
	el.setAttribute("autocomplete", "off");
}

/** 改完筆記：等筆記快取更新再重抓，並觸發同步。 */
function afterChange(plugin: StockViewPlugin): void {
	window.setTimeout(() => plugin.feed.kick(), 400);
	plugin.sync.soon();
}

export interface HoldingModalOpts {
	existing?: Holding; // 編輯（某一個清單裡的這一檔）
	list?: string; // 新增到哪個清單（預設）
	prefill?: Partial<HoldingInput>; // 新增時預先填好（「加到其他清單」）
}

export class HoldingModal extends Modal {
	private v: HoldingInput;
	private list: string;
	private lookupSeq = 0;

	constructor(
		app: App,
		private plugin: StockViewPlugin,
		private opts: HoldingModalOpts = {},
	) {
		super(app);
		const h = opts.existing;
		const pf = opts.prefill ?? {};
		this.v = {
			ticker: h?.ticker ?? pf.ticker ?? "",
			shares: h?.shares ?? pf.shares ?? null,
			cost: h?.cost ?? pf.cost ?? null,
			low: h?.low ?? pf.low ?? null,
			high: h?.high ?? pf.high ?? null,
			fair: h?.fair ?? pf.fair ?? null,
		};
		this.list = h?.list ?? opts.list ?? MAIN_LIST;
	}

	onOpen(): void {
		const el = this.contentEl;
		const h = this.opts.existing;
		const lists = this.plugin.feed.visibleLists();
		this.setTitle(h ? `編輯 ${h.ticker}${lists.length > 1 ? `（${listLabel(h.list)}）` : ""}` : "新增股票");
		if (h && h.paths.length > 1) {
			el.createEl("p", {
				cls: "setting-item-description",
				text: `${h.ticker} 在這個清單寫在 ${h.paths.length} 篇筆記裡（股數相加、成本加權平均）。這裡不能改，請直接改筆記：${h.paths.join("、")}`,
			});
			new Setting(el).addButton((b) => b.setButtonText("打開第一篇").onClick(() => (this.close(), this.plugin.openNote(h.paths[0]))));
			return;
		}

		let info: HTMLElement | null = null;
		if (!h) {
			if (lists.length > 1 || this.list !== MAIN_LIST)
				new Setting(el).setName("清單").addDropdown((d) => {
					for (const l of lists) d.addOption(l, listLabel(l));
					if (!lists.includes(this.list)) d.addOption(this.list, listLabel(this.list));
					d.setValue(this.list).onChange((x) => (this.list = x));
				});
			new Setting(el)
				.setName("代號")
				.setDesc("美股直接打代號，例如 AAPL、NVDA、BRK-B")
				.addText((t) => {
					t.inputEl.setAttribute("autocapitalize", "characters");
					t.inputEl.setAttribute("autocomplete", "off");
					t.inputEl.setAttribute("autocorrect", "off");
					t.inputEl.spellcheck = false;
					t.setPlaceholder("AAPL")
						.setValue(this.v.ticker)
						.onChange((x) => {
							this.v.ticker = normalizeTicker(x);
						});
					t.inputEl.addEventListener("blur", () => void this.lookup(info));
				});
			info = el.createDiv("sv-lookup");
		}
		const numField = (name: string, desc: string, key: "shares" | "cost" | "low" | "fair" | "high", ph: string) =>
			new Setting(el)
				.setName(name)
				.setDesc(desc)
				.addText((t) => {
					decimalInput(t.inputEl);
					t.setPlaceholder(ph)
						.setValue(this.v[key] === null ? "" : String(this.v[key]))
						.onChange((x) => {
							this.v[key] = num(x);
						});
				});
		numField("股數", "空白＝只追蹤（觀察名單，不算損益）", "shares", "50");
		numField("每股成本", "平均買進價（美元）", "cost", "120.5");
		numField("估值下限", "跌破會提醒；空白＝不設", "low", "150");
		numField("合理價位", "你認為合理的價格（只顯示和比較，不提醒）；空白＝不設", "fair", "185");
		numField("估值上限", "突破會提醒；空白＝不設", "high", "220");

		const msg = el.createDiv("sv-modal-msg");
		new Setting(el).addButton((b) =>
			b
				.setButtonText(h ? "儲存" : "新增")
				.setCta()
				.onClick(async () => {
					const e = checkInput(this.v);
					if (e) return msg.setText(e);
					if (!h && this.plugin.feed.holdings.some((x) => x.list === this.list && x.ticker === this.v.ticker))
						return msg.setText(`「${listLabel(this.list)}」已經有 ${this.v.ticker} 了，請用「編輯」修改`);
					try {
						if (h) await updateHolding(this.app, h.paths[0], this.v);
						else await addHolding(this.app, this.plugin.settings.folder, this.list, this.v);
					} catch (err) {
						return msg.setText(String((err as Error)?.message ?? err));
					}
					new Notice(h ? `已更新 ${this.v.ticker}` : `已新增 ${this.v.ticker}${lists.length > 1 ? `（${listLabel(this.list)}）` : ""}`);
					this.close();
					afterChange(this.plugin);
				}),
		);
	}

	/** 打完代號就查一次，顯示公司名稱和現價，代號打錯馬上知道。 */
	private async lookup(info: HTMLElement | null): Promise<void> {
		if (!info || !this.v.ticker) return;
		const seq = ++this.lookupSeq;
		info.setText("查詢中…");
		try {
			const q = await fetchQuote(this.v.ticker);
			if (seq !== this.lookupSeq) return;
			info.setText(`${q.name || this.v.ticker}　現價 ${F.price(q.price, q.currency)}`);
		} catch (e) {
			if (seq !== this.lookupSeq) return;
			info.setText(`查不到：${(e as Error)?.message ?? e}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class DeleteHoldingModal extends Modal {
	constructor(
		app: App,
		private plugin: StockViewPlugin,
		private h: Holding,
	) {
		super(app);
	}

	onOpen(): void {
		const el = this.contentEl;
		const many = this.plugin.feed.visibleLists().length > 1;
		this.setTitle(`從${many ? `「${listLabel(this.h.list)}」` : "清單"}刪除 ${this.h.ticker}？`);
		el.createEl("p", {
			text: `會刪除 ${this.h.paths.length} 篇筆記（${this.h.paths.join("、")}），照 Obsidian 的刪除設定移到垃圾桶，可以找回。${many ? "其他清單裡的不受影響。" : ""}`,
		});
		new Setting(el)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("刪除")
					.setWarning()
					.onClick(async () => {
						for (const p of this.h.paths) {
							const f = this.app.vault.getAbstractFileByPath(p);
							if (f instanceof TFile) await this.app.fileManager.trashFile(f);
						}
						new Notice(`已刪除 ${this.h.ticker}`);
						this.close();
						afterChange(this.plugin);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 把一檔移到別的清單（搬筆記，內容不變）。 */
export class MoveHoldingModal extends Modal {
	constructor(
		app: App,
		private plugin: StockViewPlugin,
		private h: Holding,
	) {
		super(app);
	}

	onOpen(): void {
		const el = this.contentEl;
		const feed = this.plugin.feed;
		const targets = feed.visibleLists().filter((l) => l !== this.h.list && !feed.holdings.some((x) => x.list === l && x.ticker === this.h.ticker));
		this.setTitle(`把 ${this.h.ticker} 移到…`);
		if (!targets.length) {
			el.createEl("p", { text: "其他清單都已經有這一檔了（或還沒有其他清單）。" });
			return;
		}
		let to = targets[0];
		new Setting(el).setName("移到清單").addDropdown((d) => {
			for (const l of targets) d.addOption(l, listLabel(l));
			d.setValue(to).onChange((x) => (to = x));
		});
		const msg = el.createDiv("sv-modal-msg");
		new Setting(el).addButton((b) =>
			b
				.setButtonText("移動")
				.setCta()
				.onClick(async () => {
					try {
						for (const p of this.h.paths) await moveHolding(this.app, this.plugin.settings.folder, p, this.h.ticker, to);
					} catch (e) {
						return msg.setText(String((e as Error)?.message ?? e));
					}
					new Notice(`已把 ${this.h.ticker} 移到「${listLabel(to)}」`);
					this.close();
					afterChange(this.plugin);
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 新增清單，或幫清單改名（rename＝原名稱）。 */
export class ListModal extends Modal {
	private name: string;

	constructor(
		app: App,
		private plugin: StockViewPlugin,
		private rename?: string,
	) {
		super(app);
		this.name = rename ?? "";
	}

	onOpen(): void {
		const el = this.contentEl;
		const r = this.rename;
		this.setTitle(r !== undefined ? `清單「${r}」改名` : "新增清單");
		el.createEl("p", {
			cls: "setting-item-description",
			text: `每個清單是「${this.plugin.settings.folder}」底下的一個資料夾，同一檔股票可以放在好幾個清單，各有自己的股數、成本和警示線。`,
		});
		const msg = el.createDiv("sv-modal-msg");
		const submit = async () => {
			const existing = this.plugin.feed.lists.filter((l) => l !== r);
			const err = checkListName(this.name, existing);
			if (err) return msg.setText(err);
			const name = this.name.trim();
			try {
				if (r !== undefined) await renameList(this.app, this.plugin.settings.folder, r, name);
				else await createList(this.app, this.plugin.settings.folder, name);
			} catch (e) {
				return msg.setText(String((e as Error)?.message ?? e));
			}
			this.plugin.selectList(name);
			new Notice(r !== undefined ? `已改名為「${name}」` : `已新增清單「${name}」`);
			this.close();
			afterChange(this.plugin);
		};
		new Setting(el).setName("名稱").addText((t) => {
			t.setPlaceholder("例如：AI 概念股、觀察名單、複委託帳戶")
				.setValue(this.name)
				.onChange((x) => (this.name = x));
			t.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter") void submit();
			});
		});
		el.appendChild(msg);
		new Setting(el).addButton((b) => b.setButtonText(r !== undefined ? "改名" : "新增").setCta().onClick(() => void submit()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class DeleteListModal extends Modal {
	constructor(
		app: App,
		private plugin: StockViewPlugin,
		private list: string,
	) {
		super(app);
	}

	onOpen(): void {
		const el = this.contentEl;
		const n = this.plugin.feed.holdings.filter((h) => h.list === this.list).length;
		this.setTitle(`刪除清單「${this.list}」？`);
		el.createEl("p", {
			text: `${n ? `裡面 ${n} 檔股票的筆記會一起` : "清單資料夾會"}照 Obsidian 的刪除設定移到垃圾桶，可以找回。其他清單不受影響。`,
		});
		const msg = el.createDiv("sv-modal-msg");
		new Setting(el)
			.addButton((b) => b.setButtonText("取消").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("刪除")
					.setWarning()
					.onClick(async () => {
						try {
							await deleteList(this.app, this.plugin.settings.folder, this.list);
						} catch (e) {
							return msg.setText(String((e as Error)?.message ?? e));
						}
						this.plugin.selectList(null);
						new Notice(`已刪除清單「${this.list}」`);
						this.close();
						afterChange(this.plugin);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
