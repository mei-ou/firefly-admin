import { describe, expect, it } from "vitest";
import {
	clearCommittedLocalStagedAssets,
	clearExpiredLocalStagedAssets,
	createLocalMediaDraftKey,
	createLocalMediaKey,
	createLocalStagedArticleAssetManifest,
	createLocalStagedAssetRecord,
	createLocalStagedMediaRecord,
	createUploadedLocalStagedAssetRecord,
	deleteLocalStagedMedia,
	LOCAL_MEDIA_LIMITS,
	type LocalMediaRecordStorage,
	type LocalStagedAssetRecord,
	listLocalStagedAssets,
	loadLocalStagedMedia,
	parseLocalStagedAssetRecord,
	parseLocalStagedMediaRecord,
	removeLocalStagedAsset,
	saveLocalStagedMedia,
	upsertLocalStagedAsset,
} from "../../src/components/articles/media-local-staging";

const NOW = new Date("2026-08-14T10:00:00.000Z");
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const UPLOADED_AT = "2026-08-14T09:59:00.000Z";

function createFile(name = "cover.png", type = "image/png", size = 4): File {
	return new File([new Uint8Array(size)], name, { type });
}

function createPngFile(): File {
	return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "cover.png", {
		type: "image/png",
	});
}

function createLocalId(index: number): string {
	return index.toString(16).padStart(16, "0");
}

function createAsset(
	input: {
		draftKey?: string;
		file?: File;
		localId?: string;
		now?: Date;
		role?: "attachment" | "cover" | "inline";
	} = {},
): LocalStagedAssetRecord {
	return createLocalStagedAssetRecord({
		draftKey: input.draftKey ?? "edit:hello-world",
		file: input.file ?? createPngFile(),
		localId: input.localId ?? createLocalId(1),
		now: input.now ?? NOW,
		role: input.role ?? "inline",
	});
}

class MemoryLocalMediaStorage implements LocalMediaRecordStorage {
	readonly records = new Map<string, unknown>();
	readonly legacyRecords = new Map<string, unknown>();
	closeCount = 0;
	beforeMigratePrepare: ((storage: MemoryLocalMediaStorage) => void) | undefined;

	constructor(input: { legacy?: readonly unknown[]; records?: readonly unknown[] } = {}) {
		for (const record of input.records ?? []) {
			if (typeof record === "object" && record !== null && "id" in record) {
				const id = (record as { id?: unknown }).id;
				if (typeof id === "string") this.records.set(id, record);
			}
		}
		for (const record of input.legacy ?? []) {
			if (typeof record === "object" && record !== null && "key" in record) {
				const key = (record as { key?: unknown }).key;
				if (typeof key === "string") this.legacyRecords.set(key, record);
			}
		}
	}

	async clean<TResult>(
		prepare: (rawRecords: readonly unknown[]) => {
			invalidIds: readonly string[];
			result: TResult;
		},
	): Promise<TResult> {
		const prepared = prepare([...this.records.values()]);
		for (const id of prepared.invalidIds) this.records.delete(id);
		return prepared.result;
	}

	async upsert(
		record: LocalStagedAssetRecord,
		prepare: (rawRecords: readonly unknown[]) => readonly string[],
	): Promise<void> {
		const invalidIds = prepare([...this.records.values()]);
		for (const id of invalidIds) this.records.delete(id);
		this.records.set(record.id, record);
	}

	async remove(ids: readonly string[]): Promise<void> {
		for (const id of ids) this.records.delete(id);
	}

	async migrateLegacy(
		key: string,
		prepare: (
			rawLegacy: unknown,
			rawRecords: readonly unknown[],
		) => {
			invalidIds: readonly string[];
			record?: LocalStagedAssetRecord;
			removeLegacy: boolean;
		},
	): Promise<LocalStagedAssetRecord | undefined> {
		this.beforeMigratePrepare?.(this);
		this.beforeMigratePrepare = undefined;
		const prepared = prepare(this.legacyRecords.get(key), [...this.records.values()]);
		for (const id of prepared.invalidIds) this.records.delete(id);
		if (prepared.record) this.records.set(prepared.record.id, prepared.record);
		if (prepared.removeLegacy) this.legacyRecords.delete(key);
		return prepared.record;
	}

	async deleteLegacy(key: string, recordId: string): Promise<void> {
		this.records.delete(recordId);
		this.legacyRecords.delete(key);
	}

	close(): void {
		this.closeCount += 1;
	}
}

function useStorage(storage: MemoryLocalMediaStorage) {
	return { openStorage: async () => storage };
}

describe("浏览器本地图片暂存兼容边界", () => {
	it("按已保存文章隔离旧暂存键并拒绝非法 slug", () => {
		expect(createLocalMediaKey("hello-world")).toBe("edit:hello-world");
		expect(() => createLocalMediaKey("../secret")).toThrow();
		expect(() => createLocalMediaKey("")).toThrow();
	});

	it("创建版本化 strict 记录并保留浏览器 Blob", () => {
		const file = createPngFile();
		const record = createLocalStagedMediaRecord({
			file,
			key: "edit:hello-world",
			now: new Date("2026-08-13T10:00:00.000Z"),
		});

		expect(record).toMatchObject({
			version: 1,
			key: "edit:hello-world",
			filename: "cover.png",
			contentType: "image/png",
			size: 4,
			savedAt: "2026-08-13T10:00:00.000Z",
		});
		expect(record.blob).toBe(file);
		expect(parseLocalStagedMediaRecord(record)).toEqual(record);
	});

	it("拒绝未知字段、超限文件以及 Blob 与元数据不一致", () => {
		const record = createLocalStagedMediaRecord({
			file: createPngFile(),
			key: "edit:hello-world",
		});
		expect(() => parseLocalStagedMediaRecord({ ...record, secret: "unexpected" })).toThrow();
		expect(() => parseLocalStagedMediaRecord({ ...record, size: record.size + 1 })).toThrow();
		expect(() =>
			createLocalStagedMediaRecord({
				file: createFile("large.png", "image/png", 1024 * 1024 + 1),
				key: "edit:hello-world",
			}),
		).toThrow();
	});

	it("把 v1 单图迁移到 v2 legacy 槽位且只删除兼容槽位", async () => {
		const legacy = createLocalStagedMediaRecord({
			file: createPngFile(),
			key: "edit:hello-world",
			now: NOW,
		});
		const unrelated = createAsset({ localId: createLocalId(2) });
		const storage = new MemoryLocalMediaStorage({ legacy: [legacy], records: [unrelated] });

		const loaded = await loadLocalStagedMedia("edit:hello-world", {
			...useStorage(storage),
			now: NOW,
		});

		expect(loaded).toEqual(legacy);
		expect(storage.legacyRecords.size).toBe(0);
		expect(storage.records.has("edit:hello-world:legacy")).toBe(true);
		expect(await deleteLocalStagedMedia("edit:hello-world", useStorage(storage))).toBe(true);
		expect(storage.records.has("edit:hello-world:legacy")).toBe(false);
		expect(storage.records.get(unrelated.id)).toEqual(unrelated);
	});

	it("过期 v1 单图只清理而不迁移", async () => {
		const expired = createLocalStagedMediaRecord({
			file: createPngFile(),
			key: "edit:hello-world",
			now: new Date(NOW.getTime() - 2 * ONE_DAY_MS),
		});
		const storage = new MemoryLocalMediaStorage({ legacy: [expired] });

		await expect(
			loadLocalStagedMedia("edit:hello-world", {
				...useStorage(storage),
				maxAgeMs: ONE_DAY_MS,
				now: NOW,
			}),
		).resolves.toBeNull();
		expect(storage.legacyRecords.size).toBe(0);
		expect(storage.records.size).toBe(0);
	});

	it("迁移事务保留并发写入的新 v2 legacy 记录", async () => {
		const legacy = createLocalStagedMediaRecord({
			file: createFile("old.png", "image/png", 4),
			key: "edit:hello-world",
			now: new Date(NOW.getTime() - 1_000),
		});
		const fresh = {
			...createAsset({ file: createFile("fresh.png", "image/png", 8), localId: createLocalId(6) }),
			id: "edit:hello-world:legacy",
			localId: "legacy",
		};
		const storage = new MemoryLocalMediaStorage({ legacy: [legacy] });
		storage.beforeMigratePrepare = ({ records }) => records.set(fresh.id, fresh);

		const loaded = await loadLocalStagedMedia("edit:hello-world", {
			...useStorage(storage),
			now: NOW,
		});

		expect(loaded?.filename).toBe("fresh.png");
		expect(storage.records.get(fresh.id)).toEqual(fresh);
		expect(storage.legacyRecords.size).toBe(0);
	});

	it("旧单图读取忽略同草稿的附件和非 legacy 图片", async () => {
		const attachment = createAsset({
			file: createFile("guide.pdf", "application/pdf"),
			localId: createLocalId(3),
			role: "attachment",
		});
		const image = createAsset({ localId: createLocalId(4) });
		const storage = new MemoryLocalMediaStorage({ records: [attachment, image] });

		await expect(
			loadLocalStagedMedia("edit:hello-world", { ...useStorage(storage), now: NOW }),
		).resolves.toBeNull();
	});

	it("旧单图保存只覆盖 legacy 槽位", async () => {
		const other = createAsset({ localId: createLocalId(5) });
		const storage = new MemoryLocalMediaStorage({ records: [other] });
		const legacy = createLocalStagedMediaRecord({
			file: createPngFile(),
			key: "edit:hello-world",
			now: NOW,
		});

		expect(await saveLocalStagedMedia(legacy, useStorage(storage))).toBe(true);
		expect(storage.records.get(other.id)).toEqual(other);
		expect(storage.records.has("edit:hello-world:legacy")).toBe(true);
	});
});

describe("浏览器本地多资源暂存", () => {
	it("生成稳定的新建/编辑草稿键并拒绝不安全身份", () => {
		expect(createLocalMediaDraftKey("create", "12345678-1234-1234")).toBe(
			"create:12345678-1234-1234",
		);
		expect(createLocalMediaDraftKey("edit", "hello-world")).toBe("edit:hello-world");
		expect(() => createLocalMediaDraftKey("create", "short")).toThrow();
		expect(() => createLocalMediaDraftKey("edit", "../secret")).toThrow();
	});

	it("普通 v2 写删入口拒绝占用内部 legacy 槽位", async () => {
		expect(() => createAsset({ localId: "legacy" })).toThrow();
		const storage = new MemoryLocalMediaStorage();
		const forged = {
			...createAsset({ localId: createLocalId(1) }),
			id: "edit:hello-world:legacy",
			localId: "legacy",
		};
		await expect(upsertLocalStagedAsset(forged, useStorage(storage))).rejects.toThrow();
		await expect(
			removeLocalStagedAsset("edit:hello-world", "legacy", useStorage(storage)),
		).rejects.toThrow();
		await expect(
			clearCommittedLocalStagedAssets("edit:hello-world", ["legacy"], useStorage(storage)),
		).rejects.toThrow();
		expect(storage.records.size).toBe(0);
	});

	it("把已上传资源 strict 保存并构造稳定排序的 v1 manifest", () => {
		const firstFile = createPngFile();
		const first = createUploadedLocalStagedAssetRecord({
			asset: {
				id: "123e4567-e89b-12d3-a456-426614174000",
				objectKey: "staging/2026/08/123e4567-e89b-12d3-a456-426614174000.png",
				filename: firstFile.name,
				contentType: "image/png",
				size: firstFile.size,
				etag: "etag-first",
				uploadedAt: UPLOADED_AT,
			},
			draftKey: "edit:hello-world",
			file: firstFile,
			now: NOW,
			role: "inline",
		});
		const secondFile = createFile("second.png", "image/png", 8);
		const second = createUploadedLocalStagedAssetRecord({
			asset: {
				id: "abcdefab-cdef-abcd-efab-cdefabcdefab",
				objectKey: "staging/2026/08/abcdefab-cdef-abcd-efab-cdefabcdefab.png",
				filename: secondFile.name,
				contentType: "image/png",
				size: secondFile.size,
				etag: "etag-second",
				uploadedAt: UPLOADED_AT,
			},
			draftKey: "edit:hello-world",
			file: secondFile,
			now: NOW,
			role: "cover",
		});

		expect(parseLocalStagedAssetRecord(first)).toEqual(first);
		expect(() =>
			createLocalStagedArticleAssetManifest([{ ...first, role: "cover" }, second]),
		).toThrow("最多只能有一个封面");
		expect(createLocalStagedArticleAssetManifest([first, second])).toEqual({
			version: 1,
			assets: [
				{
					version: 1,
					assetId: first.localId,
					objectKey: first.r2?.objectKey,
					etag: "etag-first",
					originalFilename: "cover.png",
					contentType: "image/png",
					size: 4,
					role: "inline",
				},
				{
					version: 1,
					assetId: second.localId,
					objectKey: second.r2?.objectKey,
					etag: "etag-second",
					originalFilename: "second.png",
					contentType: "image/png",
					size: 8,
					role: "cover",
				},
			],
		});
	});

	it("采用服务端清洗文件名并保留原 Blob 字节", async () => {
		const file = createFile("原始 封面.png", "image/png", 4);
		const record = createUploadedLocalStagedAssetRecord({
			asset: {
				id: "123e4567-e89b-12d3-a456-426614174000",
				objectKey: "staging/2026/08/123e4567-e89b-12d3-a456-426614174000.png",
				filename: "cover.png",
				contentType: "image/png",
				size: file.size,
				etag: "etag-first",
				uploadedAt: UPLOADED_AT,
			},
			draftKey: "edit:hello-world",
			file,
			now: NOW,
			role: "inline",
		});

		expect(record.filename).toBe("cover.png");
		expect(record.blob).not.toBe(file);
		expect(new Uint8Array(await record.blob.arrayBuffer())).toEqual(
			new Uint8Array(await file.arrayBuffer()),
		);
		expect(createLocalStagedArticleAssetManifest([record]).assets[0]?.originalFilename).toBe(
			"cover.png",
		);
	});

	it("拒绝 MIME 或大小不一致的 R2 响应并阻止本地-only 记录进入 manifest", () => {
		const file = createPngFile();
		const asset = {
			id: "123e4567-e89b-12d3-a456-426614174000",
			objectKey: "staging/2026/08/123e4567-e89b-12d3-a456-426614174000.png",
			filename: "cover.png",
			contentType: "image/png" as const,
			size: file.size,
			etag: "etag-first",
			uploadedAt: UPLOADED_AT,
		};
		expect(() =>
			createUploadedLocalStagedAssetRecord({
				asset: { ...asset, contentType: "image/jpeg" },
				draftKey: "edit:hello-world",
				file,
				role: "inline",
			}),
		).toThrow("不一致");
		expect(() =>
			createUploadedLocalStagedAssetRecord({
				asset: { ...asset, size: file.size + 1 },
				draftKey: "edit:hello-world",
				file,
				role: "inline",
			}),
		).toThrow("不一致");
		expect(() => createLocalStagedArticleAssetManifest([createAsset()])).toThrow("尚未上传");
	});

	it("按草稿隔离 upsert/list/remove 并允许同 localId 替换", async () => {
		const storage = new MemoryLocalMediaStorage();
		const first = createAsset({ localId: createLocalId(1) });
		const replacement = createAsset({
			file: createFile("replacement.png", "image/png", 8),
			localId: first.localId,
		});
		const otherDraft = createAsset({
			draftKey: "edit:other-post",
			localId: createLocalId(2),
		});

		expect(await upsertLocalStagedAsset(first, useStorage(storage))).toBe(true);
		expect(await upsertLocalStagedAsset(otherDraft, useStorage(storage))).toBe(true);
		expect(await upsertLocalStagedAsset(replacement, useStorage(storage))).toBe(true);

		const listed = await listLocalStagedAssets("edit:hello-world", {
			...useStorage(storage),
			now: NOW,
		});
		expect(listed?.records).toEqual([replacement]);
		expect(storage.records.get(otherDraft.id)).toEqual(otherDraft);

		expect(await removeLocalStagedAsset(first.draftKey, first.localId, useStorage(storage))).toBe(
			true,
		);
		expect(
			(await listLocalStagedAssets(first.draftKey, { ...useStorage(storage), now: NOW }))?.records,
		).toEqual([]);
		expect(storage.records.get(otherDraft.id)).toEqual(otherDraft);
	});

	it("单草稿 list 不检查或清理其他草稿的记录", async () => {
		const current = createAsset({ localId: createLocalId(1) });
		const otherExpired = createAsset({
			draftKey: "edit:other-post",
			localId: createLocalId(2),
			now: new Date(NOW.getTime() - 2 * ONE_DAY_MS),
		});
		const otherCorrupt = {
			...createAsset({ draftKey: "edit:other-post", localId: createLocalId(3) }),
			size: 999,
		};
		const storage = new MemoryLocalMediaStorage({
			records: [current, otherExpired, otherCorrupt],
		});

		expect(
			await listLocalStagedAssets("edit:hello-world", {
				...useStorage(storage),
				maxAgeMs: ONE_DAY_MS,
				now: NOW,
			}),
		).toEqual({ records: [current], removedCorrupt: 0, removedExpired: 0 });
		expect(storage.records.get(otherExpired.id)).toEqual(otherExpired);
		expect(storage.records.get(otherCorrupt.id)).toEqual(otherCorrupt);
	});

	it("list 自动清理可定位的损坏和过期记录并返回诊断计数", async () => {
		const valid = createAsset({ localId: createLocalId(1) });
		const expired = createAsset({
			localId: createLocalId(2),
			now: new Date(NOW.getTime() - 2 * ONE_DAY_MS),
		});
		const corrupt = { ...createAsset({ localId: createLocalId(3) }), size: 999 };
		const storage = new MemoryLocalMediaStorage({ records: [valid, expired, corrupt] });

		const listed = await listLocalStagedAssets("edit:hello-world", {
			...useStorage(storage),
			maxAgeMs: ONE_DAY_MS,
			now: NOW,
		});

		expect(listed).toMatchObject({
			records: [valid],
			removedCorrupt: 1,
			removedExpired: 1,
		});
		expect(storage.records.has(expired.id)).toBe(false);
		expect(storage.records.has(corrupt.id)).toBe(false);
	});

	it("clearExpired 跨草稿清理无效记录但保留有效资源", async () => {
		const valid = createAsset({ draftKey: "edit:first-post", localId: createLocalId(1) });
		const expired = createAsset({
			draftKey: "edit:second-post",
			localId: createLocalId(2),
			now: new Date(NOW.getTime() - 2 * ONE_DAY_MS),
		});
		const corrupt = { ...createAsset({ localId: createLocalId(3) }), contentType: "text/plain" };
		const storage = new MemoryLocalMediaStorage({ records: [valid, expired, corrupt] });

		expect(
			await clearExpiredLocalStagedAssets({
				...useStorage(storage),
				maxAgeMs: ONE_DAY_MS,
				now: NOW,
			}),
		).toEqual({ removedCorrupt: 1, removedExpired: 1 });
		expect([...storage.records.values()]).toEqual([valid]);
	});

	it("clearCommitted 只删除已提交的去重 localId", async () => {
		const first = createAsset({ localId: createLocalId(1) });
		const second = createAsset({ localId: createLocalId(2) });
		const otherDraft = createAsset({
			draftKey: "edit:other-post",
			localId: createLocalId(1),
		});
		const storage = new MemoryLocalMediaStorage({ records: [first, second, otherDraft] });

		expect(
			await clearCommittedLocalStagedAssets(
				first.draftKey,
				[first.localId, first.localId],
				useStorage(storage),
			),
		).toBe(true);
		expect(storage.records.has(first.id)).toBe(false);
		expect(storage.records.get(second.id)).toEqual(second);
		expect(storage.records.get(otherDraft.id)).toEqual(otherDraft);
	});

	it("拒绝 Blob 元数据不一致、用途不兼容和单文件超限", () => {
		const valid = createAsset();
		expect(() => parseLocalStagedAssetRecord({ ...valid, size: valid.size + 1 })).toThrow();
		expect(() =>
			createAsset({
				file: createFile("guide.pdf", "application/pdf"),
				role: "inline",
			}),
		).toThrow();
		expect(() =>
			createAsset({
				file: createFile("large.png", "image/png", LOCAL_MEDIA_LIMITS.imageBytes + 1),
			}),
		).toThrow();
		expect(() =>
			createAsset({
				file: createFile("large.pdf", "application/pdf", LOCAL_MEDIA_LIMITS.attachmentBytes + 1),
				role: "attachment",
			}),
		).toThrow();
	});

	it("强制每篇草稿最多 5 项", async () => {
		const storage = new MemoryLocalMediaStorage();
		for (let index = 0; index < LOCAL_MEDIA_LIMITS.maxCount; index += 1) {
			await upsertLocalStagedAsset(
				createAsset({ localId: createLocalId(index) }),
				useStorage(storage),
			);
		}

		await expect(
			upsertLocalStagedAsset(
				createAsset({ localId: createLocalId(LOCAL_MEDIA_LIMITS.maxCount) }),
				useStorage(storage),
			),
		).rejects.toThrow("最多暂存");
	});

	it("强制每篇草稿的本地资源总量不超过 5 MiB", async () => {
		const storage = new MemoryLocalMediaStorage();
		for (let index = 0; index < 1; index += 1) {
			await upsertLocalStagedAsset(
				createAsset({
					file: createFile(
						`attachment-${index}.pdf`,
						"application/pdf",
						LOCAL_MEDIA_LIMITS.attachmentBytes,
					),
					localId: createLocalId(index),
					role: "attachment",
				}),
				useStorage(storage),
			);
		}
		expect([...storage.records.values()]).toHaveLength(1);
		expect(LOCAL_MEDIA_LIMITS.totalBytes).toBe(5 * 1024 * 1024);

		await upsertLocalStagedAsset(
			createAsset({
				file: createFile("inline.png", "image/png", 1 * 1024 * 1024),
				localId: createLocalId(2),
			}),
			useStorage(storage),
		);
		await expect(
			upsertLocalStagedAsset(createAsset({ localId: createLocalId(3) }), useStorage(storage)),
		).rejects.toThrow("总量超过上限");
	});
});
