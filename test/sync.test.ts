import "../test/helpers/dom.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REMOTELY_SAVE_SYNC, SyncTrigger } from "../src/sync";

function fakeApp(opts: { hasCmd?: boolean; syncingFor?: number } = {}) {
	const calls: string[] = [];
	const rs = { isSyncing: (opts.syncingFor ?? 0) > 0 };
	let waits = 0;
	const app: any = {
		commands: {
			commands: opts.hasCmd === false ? {} : { [REMOTELY_SAVE_SYNC]: {} },
			executeCommandById: (id: string) => (calls.push(id), true),
		},
		plugins: { plugins: { "remotely-save": rs } },
	};
	const sleep = async () => {
		waits++;
		if (waits >= (opts.syncingFor ?? 0)) rs.isSyncing = false;
	};
	return { app, calls, rs, sleep, waits: () => waits };
}

test("觸發 Remotely Save 同步；太密就略過", async () => {
	const f = fakeApp();
	const s = new SyncTrigger(f.app, () => true, f.sleep);
	assert.equal(s.available(), true);
	assert.equal(await s.now(60_000), true);
	assert.deepEqual(f.calls, [REMOTELY_SAVE_SYNC]);
	assert.equal(await s.now(60_000), false, "60 秒內不重複");
	assert.equal(await s.now(), true, "改了清單（不限間隔）一定同步");
	assert.equal(f.calls.length, 2);
});

test("正在同步時先等它結束再觸發", async () => {
	const f = fakeApp({ syncingFor: 3 });
	const s = new SyncTrigger(f.app, () => true, f.sleep);
	await s.now();
	assert.equal(f.waits(), 3);
	assert.deepEqual(f.calls, [REMOTELY_SAVE_SYNC]);
});

test("關掉設定或沒裝 Remotely Save 就不做事", async () => {
	const off = fakeApp();
	assert.equal(await new SyncTrigger(off.app, () => false, off.sleep).now(), false);
	assert.equal(off.calls.length, 0);
	const none = fakeApp({ hasCmd: false });
	const s = new SyncTrigger(none.app, () => true, none.sleep);
	assert.equal(s.available(), false);
	assert.equal(await s.now(), false);
	assert.equal(await new SyncTrigger({} as never, () => true).now(), false, "app.commands 不存在也不會壞");
});

test("soon：連續改好幾檔只同步一次", async () => {
	const f = fakeApp();
	const s = new SyncTrigger(f.app, () => true, f.sleep);
	s.soon(20);
	s.soon(20);
	s.soon(20);
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(f.calls.length, 1);
});
