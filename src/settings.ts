// 設定頁與 Finnhub 金鑰視窗。
// 金鑰只存在 app.secretStorage（這台裝置的 Obsidian 安全儲存區），不寫進 data.json、不寫進筆記，不會同步到 Dropbox。
// 設定頁不放 SecretComponent（Language Learning 在 iPad 上遇過設定頁當掉），改成一列摘要＋「設定…」按鈕開視窗。
import { App, Modal, PluginSettingTab, Setting } from "obsidian";
import type StockViewPlugin from "./main";
import { SECRET_FINNHUB, cleanKey, fetchRating, ratingInfo } from "./ratings";

export class FinnhubKeyModal extends Modal {
	constructor(
		app: App,
		private plugin: StockViewPlugin,
		private onDone: () => void = () => undefined,
	) {
		super(app);
	}

	onOpen(): void {
		const p = this.plugin;
		const el = this.contentEl;
		this.setTitle("Finnhub 金鑰（華爾街評級）");
		el.createEl("p", {
			cls: "setting-item-description",
			text: "免費：到 finnhub.io 註冊（不用信用卡），登入後 Dashboard 上的 API Key 複製貼到這裡。金鑰存在這台裝置的 Obsidian 安全儲存區，不進 Vault、不同步；每台裝置各貼一次。",
		});
		const ss = this.app.secretStorage;
		if (!ss) {
			el.createEl("p", { text: "這個版本的 Obsidian 沒有安全儲存區，請先更新 Obsidian（1.11.4 以上）。" });
			return;
		}
		const has = () => !!ss.getSecret(SECRET_FINNHUB);
		const keySetting = new Setting(el)
			.setName("API key")
			.setDesc(has() ? "已設定。要換就貼上新的。" : "貼上金鑰。")
			.addText((t) => {
				// 不用 type=password（iPad 的密碼自動填入可能出問題）
				t.inputEl.setAttribute("autocomplete", "off");
				t.inputEl.setAttribute("autocapitalize", "off");
				t.inputEl.setAttribute("autocorrect", "off");
				t.inputEl.spellcheck = false;
				t.setPlaceholder(has() ? "（已設定，要換才貼）" : "貼上 Finnhub API key");
				t.onChange((v) => {
					const key = cleanKey(v);
					if (!key) return;
					try {
						ss.setSecret(SECRET_FINNHUB, key);
						p.ratings.clear();
						keySetting.setDesc(key.length < 15 ? `已儲存，但只有 ${key.length} 個字元，看起來不完整，請重新複製整把金鑰。` : "已儲存。按「測試」確認能用。");
					} catch (e) {
						keySetting.setDesc(`儲存失敗：${(e as Error)?.message ?? e}`);
					}
				});
			});
		const result = el.createDiv("sv-modal-msg");
		new Setting(el)
			.addButton((b) =>
				b.setButtonText("測試（查 AAPL）").onClick(async () => {
					const key = ss.getSecret(SECRET_FINNHUB);
					if (!key) return result.setText("還沒有金鑰");
					result.setText("查詢中…");
					try {
						const r = await fetchRating("AAPL", key);
						const info = ratingInfo(r);
						result.setText(info ? `可以用：AAPL ${info.label}（${info.total} 位分析師，${r?.period}）` : "連得上，但沒有 AAPL 的資料");
					} catch (e) {
						result.setText(`失敗：${(e as Error)?.message ?? e}`);
					}
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("清除金鑰")
					.setWarning()
					.onClick(() => {
						ss.setSecret(SECRET_FINNHUB, "");
						p.ratings.clear();
						keySetting.setDesc("已清除。");
						result.setText("");
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDone();
		this.plugin.feed.kick();
	}
}

export class StockViewSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: StockViewPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const p = this.plugin;
		const s = p.settings;
		const el = this.containerEl;
		el.empty();
		const save = async () => {
			await p.saveSettings();
			p.feed.kick();
		};

		new Setting(el).setName("持股").setHeading();
		new Setting(el)
			.setName("股票筆記資料夾")
			.setDesc("每檔股票一篇筆記，frontmatter 寫 ticker、shares、cost、low、high（和之前 Dataview 儀表板的格式一樣）")
			.addText((t) =>
				t
					.setPlaceholder("Portfolio")
					.setValue(s.folder)
					.onChange(async (v) => {
						s.folder = v.trim().replace(/^\/+|\/+$/g, "") || "Portfolio";
						await save();
					}),
			);
		new Setting(el)
			.setName("總計幣別")
			.setDesc("總市值、總損益用哪種幣別顯示（各檔仍用自己的幣別）")
			.addDropdown((d) =>
				d
					.addOptions({ USD: "美元 USD", TWD: "台幣 TWD" })
					.setValue(s.base)
					.onChange(async (v) => {
						s.base = v === "TWD" ? "TWD" : "USD";
						await save();
					}),
			);
		new Setting(el)
			.setName("自動同步（Remotely Save）")
			.setDesc("新增／修改／刪除股票後、打開儀表板或按重新整理時，自動觸發 Remotely Save 同步，別台裝置很快就看得到。沒裝 Remotely Save 就不會做任何事。")
			.addToggle((t) =>
				t.setValue(s.autoSync).onChange(async (v) => {
					s.autoSync = v;
					await save();
				}),
			);
		new Setting(el).setName("漲跌顏色").addDropdown((d) =>
			d
				.addOptions({ tw: "紅漲綠跌（台灣）", us: "綠漲紅跌（美國）" })
				.setValue(s.colorStyle)
				.onChange(async (v) => {
					s.colorStyle = v === "us" ? "us" : "tw";
					await save();
				}),
		);

		new Setting(el).setName("更新頻率").setHeading();
		const secField = (name: string, desc: string, key: "refreshSec" | "closedRefreshSec", min: number) =>
			new Setting(el)
				.setName(name)
				.setDesc(desc)
				.addText((t) => {
					t.inputEl.setAttribute("inputmode", "numeric");
					t.setValue(String(s[key])).onChange(async (v) => {
						const n = Number(v);
						if (!isFinite(n) || n < min) return;
						s[key] = n;
						await save();
					});
				});
		secField("開盤時（秒）", "儀表板開著、盤前／盤中／盤後時多久更新一次（最少 3 秒）", "refreshSec", 3);
		secField("收盤時（秒）", "儀表板開著、收盤時多久更新一次（最少 10 秒）", "closedRefreshSec", 10);

		new Setting(el).setName("價格警示").setHeading();
		new Setting(el).setName("開啟價格警示").setDesc("突破估值上限或跌破下限時提醒").addToggle((t) =>
			t.setValue(s.alarmEnabled).onChange(async (v) => {
				s.alarmEnabled = v;
				await save();
			}),
		);
		new Setting(el).setName("盤前、盤後也提醒").setDesc("用盤前／盤後價判斷").addToggle((t) =>
			t.setValue(s.alarmUseExtended).onChange(async (v) => {
				s.alarmUseExtended = v;
				await save();
			}),
		);
		new Setting(el)
			.setName("緩衝區（%）")
			.setDesc("提醒過之後，價格要回到界線內這麼多才會再提醒（震盪時不會一直響）")
			.addText((t) => {
				t.inputEl.setAttribute("inputmode", "decimal");
				t.setValue(String(s.alarmBufferPct)).onChange(async (v) => {
					const n = Number(v);
					if (!isFinite(n) || n < 0 || n > 20) return;
					s.alarmBufferPct = n;
					await save();
				});
			});
		new Setting(el)
			.setName("冷卻時間（分鐘）")
			.setDesc("同一檔提醒過之後，這段時間內不再提醒")
			.addText((t) => {
				t.inputEl.setAttribute("inputmode", "numeric");
				t.setValue(String(s.alarmCooldownMin)).onChange(async (v) => {
					const n = Number(v);
					if (!isFinite(n) || n < 0 || n > 1440) return;
					s.alarmCooldownMin = n;
					await save();
				});
			});
		new Setting(el).setName("提示音").addToggle((t) =>
			t.setValue(s.alarmSound).onChange(async (v) => {
				s.alarmSound = v;
				await save();
			}),
		);
		new Setting(el)
			.setName("儀表板沒開也檢查")
			.setDesc("Obsidian 開著就在背景檢查警示（開盤 30 秒、收盤 5 分鐘一次）。iPad 切到別的 App 時 Obsidian 會暫停，回來才繼續。")
			.addToggle((t) =>
				t.setValue(s.backgroundAlarm).onChange(async (v) => {
					s.backgroundAlarm = v;
					await save();
				}),
			);

		new Setting(el).setName("華爾街評級").setHeading();
		new Setting(el).setName("顯示華爾街評級").setDesc("分析師共識（Finnhub 免費接口，每月更新），僅供參考").addToggle((t) =>
			t.setValue(s.showRatings).onChange(async (v) => {
				s.showRatings = v;
				await save();
			}),
		);
		const keyRow = new Setting(el).setName("Finnhub 金鑰");
		const refreshKeyRow = () => keyRow.setDesc(p.ratings.key() ? "已設定（只存在這台裝置）" : "還沒設定（免費註冊 finnhub.io）");
		refreshKeyRow();
		keyRow.addButton((b) => b.setButtonText("設定…").onClick(() => new FinnhubKeyModal(this.app, p, refreshKeyRow).open()));

		el.createDiv({ cls: "setting-item-description sv-version", text: `StockView ${p.manifest.version}` });
	}
}
