import { describe, expect, it } from "vitest";
import {
	type BrowserKeyValueStorage,
	clearArticleMediaDraftId,
	createArticleDraftKey,
	createArticleDraftRecord,
	getOrCreateArticleMediaDraftId,
	parseArticleDraftRecord,
	restoreArticleDraftForm,
} from "../../src/components/articles/article-draft-store";
import { createEmptyArticleForm } from "../../src/components/articles/article-editor-state";

const FILE_SHA = "a".repeat(40);
const FIRST_DRAFT_ID = "12345678-1234-1234";
const SECOND_DRAFT_ID = "abcdefab-cdef-abcd";

class MemoryKeyValueStorage implements BrowserKeyValueStorage {
	readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}
}

function createFilledForm() {
	const form = createEmptyArticleForm(new Date("2026-08-12T00:00:00.000Z"));
	form.storageSlug = "hello-world";
	form.title = "本地草稿";
	form.markdown = "# 尚未提交\n";
	form.password = "must-not-persist";
	form.passwordHint = "must-not-persist-either";
	return form;
}

describe("文章本地草稿边界", () => {
	it("隔离新建与编辑草稿键并拒绝非法 slug", () => {
		expect(createArticleDraftKey("create")).toBe("create");
		expect(createArticleDraftKey("edit", "hello-world")).toBe("edit:hello-world");
		expect(() => createArticleDraftKey("edit", "../secret")).toThrow();
		expect(() => createArticleDraftKey("edit")).toThrow();
	});

	it("为新文章复用稳定媒体草稿 ID，并清理损坏值后重建", () => {
		const storage = new MemoryKeyValueStorage();
		expect(getOrCreateArticleMediaDraftId({ storage, createId: () => FIRST_DRAFT_ID })).toBe(
			FIRST_DRAFT_ID,
		);
		expect(getOrCreateArticleMediaDraftId({ storage, createId: () => SECOND_DRAFT_ID })).toBe(
			FIRST_DRAFT_ID,
		);

		storage.values.set("firefly-admin:create-media-draft-id", "../invalid");
		expect(getOrCreateArticleMediaDraftId({ storage, createId: () => SECOND_DRAFT_ID })).toBe(
			SECOND_DRAFT_ID,
		);
	});

	it("无浏览器存储时仍生成本页身份，且按期望值清理防止跨页面误删", () => {
		expect(getOrCreateArticleMediaDraftId({ createId: () => FIRST_DRAFT_ID })).toBe(FIRST_DRAFT_ID);
		const storage = new MemoryKeyValueStorage();
		storage.setItem("firefly-admin:create-media-draft-id", SECOND_DRAFT_ID);
		expect(clearArticleMediaDraftId(FIRST_DRAFT_ID, { storage })).toBe(false);
		expect(storage.getItem("firefly-admin:create-media-draft-id")).toBe(SECOND_DRAFT_ID);
		expect(clearArticleMediaDraftId(SECOND_DRAFT_ID, { storage })).toBe(true);
		expect(storage.getItem("firefly-admin:create-media-draft-id")).toBeNull();
		expect(() => clearArticleMediaDraftId("../invalid", { storage })).toThrow();
	});

	it("创建版本化 strict 记录且不持久化密码字段", () => {
		const record = createArticleDraftRecord({
			key: "edit:hello-world",
			baseSha: FILE_SHA,
			form: createFilledForm(),
			now: new Date("2026-08-12T03:00:00.000Z"),
		});

		expect(record).toMatchObject({
			version: 1,
			key: "edit:hello-world",
			baseSha: FILE_SHA,
			savedAt: "2026-08-12T03:00:00.000Z",
			form: { title: "本地草稿", markdown: "# 尚未提交\n" },
		});
		expect(record.form).not.toHaveProperty("password");
		expect(record.form).not.toHaveProperty("passwordHint");
	});

	it("拒绝未来版本、额外字段和无效 SHA 的持久化数据", () => {
		const record = createArticleDraftRecord({
			key: "create",
			form: createFilledForm(),
			now: new Date("2026-08-12T03:00:00.000Z"),
		});
		expect(() => parseArticleDraftRecord({ ...record, version: 2 })).toThrow();
		expect(() => parseArticleDraftRecord({ ...record, secret: "unexpected" })).toThrow();
		expect(() => parseArticleDraftRecord({ ...record, baseSha: "invalid" })).toThrow();
	});

	it("恢复普通字段时保留当前远端密码和密码提示", () => {
		const current = createFilledForm();
		current.password = "remote-password";
		current.passwordHint = "remote-hint";
		const draft = createArticleDraftRecord({ key: "edit:hello-world", form: createFilledForm() });
		const restored = restoreArticleDraftForm(current, draft);

		expect(restored.title).toBe("本地草稿");
		expect(restored.password).toBe("remote-password");
		expect(restored.passwordHint).toBe("remote-hint");
	});
});
