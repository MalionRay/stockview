// 警示訊息（v0.9.0）：響過的警示都留在這裡，直到使用者自己刪掉。
// 打開就算看過（儀表板的鈴鐺、桌機狀態列的未讀數會歸零）；這次打開前還沒看過的標「新」。
import { App, Modal, setIcon } from "obsidian";
import { alarmText, isUpAlarm } from "./alarm";
import { INBOX_MAX } from "./alarms";
import * as F from "./format";
import type StockViewPlugin from "./main";

export class AlarmInboxModal extends Modal {
	private unsub: (() => void) | null = null;
	private fresh = new Set<string>(); // 這次打開前還沒看過的（標「新」）
	private armTimer = 0;

	constructor(
		app: App,
		private plugin: StockViewPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("警示訊息");
		this.modalEl.addClass("sv-inbox-modal");
		this.unsub = this.plugin.alarms.onChange(() => this.draw());
		this.draw();
	}

	private draw(): void {
		const al = this.plugin.alarms;
		const el = this.contentEl;
		window.clearTimeout(this.armTimer);
		// 開著的時候新響的也標「新」
		for (const e of al.log) if (!e.read) this.fresh.add(e.id);
		el.empty();
		const log = al.log;
		if (!log.length) {
			el.createDiv({
				cls: "sv-inbox-empty",
				text: "沒有警示訊息。價格碰到估值上下限、或穿過合理價位時，訊息會留在這裡，直到你刪掉。",
			});
		} else {
			el.createDiv({
				cls: "setting-item-description",
				text: `共 ${log.length} 則，留到你刪掉為止（最多 ${INBOX_MAX} 則，太多會從最舊的刪）。只有這台裝置響過的警示。`,
			});
			const list = el.createDiv("sv-inbox");
			for (const e of log) {
				const isNew = this.fresh.has(e.id);
				const row = list.createDiv({ cls: `sv-inbox-item${isNew ? " is-new" : ""}` });
				const body = row.createDiv("sv-inbox-body");
				body.createDiv({ cls: `sv-inbox-text sv-${isUpAlarm(e.kind) ? "up" : "down"}`, text: alarmText(e) });
				const meta = body.createDiv("sv-inbox-time");
				if (isNew) meta.createSpan({ cls: "sv-inbox-new", text: "新" });
				meta.createSpan({ text: F.dateTime(e.at) });
				const x = row.createEl("button", { cls: "sv-inbox-del clickable-icon", attr: { "aria-label": "刪除這則" } });
				setIcon(x, "x");
				x.onclick = () => al.remove([e.id]);
			}
			const foot = el.createDiv("sv-inbox-foot");
			const all = foot.createEl("button", { text: "全部刪除" });
			let armed = false;
			all.onclick = () => {
				if (!armed) {
					// 第一下只是確認，4 秒內再按一次才真的刪
					armed = true;
					all.setText(`確定刪除全部 ${log.length} 則？再按一次`);
					all.addClass("mod-warning");
					this.armTimer = window.setTimeout(() => {
						armed = false;
						all.setText("全部刪除");
						all.removeClass("mod-warning");
					}, 4000);
					return;
				}
				al.clearLog();
			};
		}
		// 打開就算看過（會再畫一次，但那時已經沒有未讀，不會一直重畫）
		if (al.unread()) al.markRead();
	}

	onClose(): void {
		window.clearTimeout(this.armTimer);
		this.unsub?.();
		this.unsub = null;
		this.contentEl.empty();
	}
}
