// 新增／編輯／刪除股票的視窗（iPad 上不用開筆記就能改）。
import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { Holding, HoldingInput, addHolding, checkInput, num, updateHolding } from "./holdings";
import type StockViewPlugin from "./main";
import * as F from "./format";
import { fetchQuote, normalizeTicker } from "./quote";

function decimalInput(el: HTMLInputElement): void {
	el.setAttribute("inputmode", "decimal");
	el.setAttribute("autocomplete", "off");
}

export class HoldingModal extends Modal {
	private v: HoldingInput;
	private lookupSeq = 0;

	constructor(
		app: App,
		private plugin: StockViewPlugin,
		private existing?: Holding,
	) {
		super(app);
		const h = existing;
		this.v = { ticker: h?.ticker ?? "", shares: h?.shares ?? null, cost: h?.cost ?? null, low: h?.low ?? null, high: h?.high ?? null };
	}

	onOpen(): void {
		const el = this.contentEl;
		const h = this.existing;
		this.setTitle(h ? `編輯 ${h.ticker}` : "新增股票");
		if (h && h.paths.length > 1) {
			el.createEl("p", {
				cls: "setting-item-description",
				text: `${h.ticker} 寫在 ${h.paths.length} 篇筆記裡（股數相加、成本加權平均）。這裡不能改，請直接改筆記：${h.paths.join("、")}`,
			});
			new Setting(el).addButton((b) => b.setButtonText("打開第一篇").onClick(() => (this.close(), this.plugin.openNote(h.paths[0]))));
			return;
		}

		let info: HTMLElement | null = null;
		if (!h) {
			new Setting(el)
				.setName("代號")
				.setDesc("美股直接打代號，例如 AAPL、NVDA、BRK-B")
				.addText((t) => {
					t.inputEl.setAttribute("autocapitalize", "characters");
					t.inputEl.setAttribute("autocomplete", "off");
					t.inputEl.setAttribute("autocorrect", "off");
					t.inputEl.spellcheck = false;
					t.setPlaceholder("AAPL").onChange((x) => {
						this.v.ticker = normalizeTicker(x);
					});
					t.inputEl.addEventListener("blur", () => void this.lookup(info));
				});
			info = el.createDiv("sv-lookup");
		}
		const numField = (name: string, desc: string, key: "shares" | "cost" | "low" | "high", ph: string) =>
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
		numField("估值上限", "突破會提醒；空白＝不設", "high", "220");

		const msg = el.createDiv("sv-modal-msg");
		new Setting(el).addButton((b) =>
			b
				.setButtonText(h ? "儲存" : "新增")
				.setCta()
				.onClick(async () => {
					const e = checkInput(this.v);
					if (e) return msg.setText(e);
					try {
						if (h) await updateHolding(this.app, h.paths[0], this.v);
						else await addHolding(this.app, this.plugin.settings.folder, this.v);
					} catch (err) {
						return msg.setText(String((err as Error)?.message ?? err));
					}
					new Notice(h ? `已更新 ${this.v.ticker}` : `已新增 ${this.v.ticker}`);
					this.close();
					this.plugin.sync.soon();
					// 等筆記快取更新再重抓
					window.setTimeout(() => this.plugin.feed.kick(), 400);
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
		this.setTitle(`刪除 ${this.h.ticker}？`);
		el.createEl("p", {
			text: `會刪除 ${this.h.paths.length} 篇筆記（${this.h.paths.join("、")}），照 Obsidian 的刪除設定移到垃圾桶，可以找回。`,
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
						this.plugin.sync.soon();
						window.setTimeout(() => this.plugin.feed.kick(), 400);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
