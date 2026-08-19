import { z } from "zod";
import {
	ARTICLE_ASSET_ATTACHMENT_MAX_BYTES,
	ARTICLE_ASSET_IMAGE_MAX_BYTES,
	ARTICLE_ASSET_MAX_COUNT,
	ARTICLE_ASSET_TOTAL_MAX_BYTES,
	type ArticleAssetRole,
	getMediaMaxBytes,
	isMediaRoleCompatible,
	MEDIA_STAGING_OBJECT_KEY_PATTERN,
	type MediaStagingContentType,
} from "../../modules/media/media-config";
import type { StagedMediaAsset } from "./media-staging";

const DATABASE_NAME = "firefly-admin-media";
const DATABASE_VERSION = 2;
const LEGACY_STORE_NAME = "staged-images";
const STORE_NAME = "staged-assets";
const DRAFT_KEY_PATTERN = /^(?:create:[a-f0-9-]{16,64}|edit:[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const LOCAL_ID_PATTERN = /^(?:legacy|[a-f0-9-]{16,64})$/;
const RECORD_ID_PATTERN =
	/^(?:create:[a-f0-9-]{16,64}|edit:[a-z0-9]+(?:-[a-z0-9]+)*):(?:legacy|[a-f0-9-]{16,64})$/;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const RECORD_VERSION = 2;
const LEGACY_RECORD_VERSION = 1;
const LEGACY_MEDIA_KEY_PATTERN = /^edit:[a-z0-9]+(?:-[a-z0-9]+)*$/;

const contentTypeSchema = z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const roleSchema = z.enum(["attachment", "cover", "inline"]);
const r2IdentitySchema = z
	.object({
		assetId: z.string().regex(/^[a-f0-9-]{16,64}$/i),
		objectKey: z.string().regex(MEDIA_STAGING_OBJECT_KEY_PATTERN),
		etag: z.string().min(1).max(500),
		uploadedAt: z.iso.datetime({ offset: true }),
	})
	.strict();
const localStagedAssetMetadataSchema = z
	.object({
		version: z.literal(RECORD_VERSION),
		id: z.string().regex(RECORD_ID_PATTERN),
		draftKey: z.string().regex(DRAFT_KEY_PATTERN),
		localId: z.string().regex(LOCAL_ID_PATTERN),
		filename: z.string().min(1).max(255),
		contentType: contentTypeSchema,
		size: z.number().int().positive().max(ARTICLE_ASSET_ATTACHMENT_MAX_BYTES),
		role: roleSchema,
		r2: r2IdentitySchema.optional(),
		savedAt: z.iso.datetime({ offset: true }),
	})
	.strict()
	.superRefine((record, context) => {
		if (record.id !== createRecordId(record.draftKey, record.localId)) {
			context.addIssue({ code: "custom", message: "本地暂存资源身份不一致。" });
		}
		if (record.size > getMediaMaxBytes(record.contentType)) {
			context.addIssue({ code: "custom", message: "本地暂存资源超过类型大小上限。" });
		}
		if (!isMediaRoleCompatible(record.contentType, record.role)) {
			context.addIssue({ code: "custom", message: "本地暂存资源用途与类型不兼容。" });
		}
		if (record.r2 && record.r2.assetId !== record.localId) {
			context.addIssue({ code: "custom", message: "R2 暂存身份与本地资源身份不一致。" });
		}
	});
const legacyMetadataSchema = z
	.object({
		version: z.literal(LEGACY_RECORD_VERSION),
		key: z.string().regex(LEGACY_MEDIA_KEY_PATTERN),
		filename: z.string().min(1).max(255),
		contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
		size: z
			.number()
			.int()
			.positive()
			.max(1024 * 1024),
		savedAt: z.iso.datetime({ offset: true }),
	})
	.strict();

export interface LocalStagedAssetRecord extends z.infer<typeof localStagedAssetMetadataSchema> {
	blob: Blob;
}

/** 兼容旧 ImageDialog 的单图记录输入；保存时会转入 v2 的 legacy 槽位。 */
export interface LocalStagedMediaRecord extends z.infer<typeof legacyMetadataSchema> {
	blob: Blob;
}

export interface LocalStagedAssetListResult {
	records: LocalStagedAssetRecord[];
	removedCorrupt: number;
	removedExpired: number;
}

export interface LocalStagedArticleAssetManifest {
	version: 1;
	assets: Array<{
		version: 1;
		assetId: string;
		objectKey: string;
		etag: string;
		originalFilename: string;
		contentType: MediaStagingContentType;
		size: number;
		role: ArticleAssetRole;
	}>;
}

type PrepareLocalMediaUpsert = (rawRecords: readonly unknown[]) => readonly string[];
type PrepareLocalMediaClean<TResult> = (rawRecords: readonly unknown[]) => {
	invalidIds: readonly string[];
	result: TResult;
};
type PrepareLegacyMigration = (
	rawLegacy: unknown,
	rawRecords: readonly unknown[],
) => {
	invalidIds: readonly string[];
	record?: LocalStagedAssetRecord;
	removeLegacy: boolean;
};

export interface LocalMediaRecordStorage {
	/** 扫描和删除必须处于同一个写事务，避免清理掉扫描完成后才写入的新记录。 */
	clean<TResult>(prepare: PrepareLocalMediaClean<TResult>): Promise<TResult>;
	/** 校验回调与写入必须处于同一个串行化写事务，防止并发请求绕过数量和总量限制。 */
	upsert(record: LocalStagedAssetRecord, prepare: PrepareLocalMediaUpsert): Promise<void>;
	remove(ids: readonly string[]): Promise<void>;
	/** v1 读取、v2 校验/写入和 v1 删除必须跨两个 Store 原子完成。 */
	migrateLegacy(
		key: string,
		prepare: PrepareLegacyMigration,
	): Promise<LocalStagedAssetRecord | undefined>;
	deleteLegacy(key: string, recordId: string): Promise<void>;
	close(): void;
}

interface LocalMediaStorageDependencies {
	openStorage?: () => Promise<LocalMediaRecordStorage | null>;
}

interface ListLocalStagedAssetsOptions extends LocalMediaStorageDependencies {
	maxAgeMs?: number;
	now?: Date;
}

function parseDate(input: Date, label: string): Date {
	if (!Number.isFinite(input.getTime())) throw new TypeError(`${label}无效。`);
	return input;
}

function parseMaxAgeMs(input: number): number {
	if (!Number.isInteger(input) || input <= 0 || input > 365 * 24 * 60 * 60 * 1_000) {
		throw new TypeError("本地暂存保留时间无效。");
	}
	return input;
}

function createRecordId(draftKey: string, localId: string): string {
	return z.string().regex(RECORD_ID_PATTERN).parse(`${draftKey}:${localId}`);
}

function parsePublicLocalId(input: string): string {
	return z
		.string()
		.regex(/^[a-f0-9-]{16,64}$/)
		.parse(input);
}

export function createLocalMediaDraftKey(mode: "create" | "edit", identifier: string): string {
	return z
		.string()
		.regex(DRAFT_KEY_PATTERN)
		.parse(mode === "create" ? `create:${identifier}` : `edit:${identifier}`);
}

/** 旧单图流程只允许已保存文章；新建文章后续必须传稳定的本地 draft ID。 */
export function createLocalMediaKey(storageSlug: string): string {
	return createLocalMediaDraftKey("edit", storageSlug);
}

function createLocalStagedAssetRecordInternal(input: {
	draftKey: string;
	file: File;
	localId: string;
	now?: Date;
	r2?: z.infer<typeof r2IdentitySchema>;
	role: ArticleAssetRole;
}): LocalStagedAssetRecord {
	const metadata = localStagedAssetMetadataSchema.parse({
		version: RECORD_VERSION,
		id: createRecordId(input.draftKey, input.localId),
		draftKey: input.draftKey,
		localId: input.localId,
		filename: input.file.name,
		contentType: input.file.type,
		size: input.file.size,
		role: input.role,
		...(input.r2 ? { r2: input.r2 } : {}),
		savedAt: parseDate(input.now ?? new Date(), "本地暂存时间").toISOString(),
	});
	return { ...metadata, blob: input.file };
}

export function createLocalStagedAssetRecord(input: {
	draftKey: string;
	file: File;
	localId?: string;
	now?: Date;
	role: ArticleAssetRole;
}): LocalStagedAssetRecord {
	const localId = parsePublicLocalId(input.localId ?? crypto.randomUUID());
	return createLocalStagedAssetRecordInternal({ ...input, localId });
}

export function createUploadedLocalStagedAssetRecord(input: {
	asset: StagedMediaAsset;
	draftKey: string;
	file: File;
	now?: Date;
	role: ArticleAssetRole;
}): LocalStagedAssetRecord {
	if (input.asset.contentType !== input.file.type || input.asset.size !== input.file.size) {
		throw new TypeError("R2 暂存响应与本地文件不一致。");
	}
	// 文件名由服务端清洗后返回；本地只复用原 Blob 字节，不把浏览器原始名称带入提交清单。
	const normalizedFile = new File([input.file], input.asset.filename, {
		lastModified: input.file.lastModified,
		type: input.asset.contentType,
	});
	return createLocalStagedAssetRecordInternal({
		draftKey: input.draftKey,
		file: normalizedFile,
		localId: parsePublicLocalId(input.asset.id),
		...(input.now ? { now: input.now } : {}),
		r2: {
			assetId: input.asset.id,
			objectKey: input.asset.objectKey,
			etag: input.asset.etag,
			uploadedAt: input.asset.uploadedAt,
		},
		role: input.role,
	});
}

export function parseLocalStagedAssetRecord(input: unknown): LocalStagedAssetRecord {
	if (typeof input !== "object" || input === null || !("blob" in input)) {
		throw new TypeError("本地暂存资源记录无效。");
	}
	const { blob, ...metadata } = input as Record<string, unknown>;
	const parsed = localStagedAssetMetadataSchema.parse(metadata);
	if (!(blob instanceof Blob) || blob.size !== parsed.size || blob.type !== parsed.contentType) {
		throw new TypeError("本地暂存资源内容与元数据不一致。");
	}
	return { ...parsed, blob };
}

export function createLocalStagedMediaRecord(input: {
	file: File;
	key: string;
	now?: Date;
}): LocalStagedMediaRecord {
	const metadata = legacyMetadataSchema.parse({
		version: LEGACY_RECORD_VERSION,
		key: input.key,
		filename: input.file.name,
		contentType: input.file.type,
		size: input.file.size,
		savedAt: parseDate(input.now ?? new Date(), "本地暂存时间").toISOString(),
	});
	return { ...metadata, blob: input.file };
}

export function parseLocalStagedMediaRecord(input: unknown): LocalStagedMediaRecord {
	if (typeof input !== "object" || input === null || !("blob" in input)) {
		throw new TypeError("本地暂存图片记录无效。");
	}
	const { blob, ...metadata } = input as Record<string, unknown>;
	const parsed = legacyMetadataSchema.parse(metadata);
	if (!(blob instanceof Blob) || blob.size !== parsed.size || blob.type !== parsed.contentType) {
		throw new TypeError("本地暂存图片内容与元数据不一致。");
	}
	return { ...parsed, blob };
}

function runRequest<T>(request: IDBRequest<T>, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error(message));
	});
}

function waitForTransaction(transaction: IDBTransaction, message: string): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		// 请求错误会触发事务终止；只在最终 abort 时拒绝，避免数据库尚未回滚就提前关闭连接。
		transaction.onabort = () => reject(transaction.error ?? new Error(message));
	});
}

function openDatabase(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(LEGACY_STORE_NAME)) {
				database.createObjectStore(LEGACY_STORE_NAME, { keyPath: "key" });
			}
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME, { keyPath: "id" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("无法打开本地资源暂存区。"));
		request.onblocked = () => reject(new Error("本地资源暂存区升级被其他页面阻塞。"));
	});
}

async function openIndexedDbStorage(): Promise<LocalMediaRecordStorage | null> {
	const database = await openDatabase();
	if (!database) return null;
	return {
		async clean<TResult>(prepare: PrepareLocalMediaClean<TResult>): Promise<TResult> {
			const transaction = database.transaction(STORE_NAME, "readwrite");
			const store = transaction.objectStore(STORE_NAME);
			let result: TResult;
			try {
				const prepared = prepare(await runRequest(store.getAll(), "读取本地资源暂存区失败。"));
				result = prepared.result;
				for (const id of prepared.invalidIds) store.delete(id);
			} catch (error) {
				transaction.abort();
				await waitForTransaction(transaction, "清理本地资源失败。").catch(() => undefined);
				throw error;
			}
			await waitForTransaction(transaction, "清理本地资源失败。");
			return result;
		},
		async upsert(record, prepare) {
			const transaction = database.transaction(STORE_NAME, "readwrite");
			const store = transaction.objectStore(STORE_NAME);
			try {
				const invalidIds = prepare(await runRequest(store.getAll(), "读取本地资源暂存区失败。"));
				for (const id of invalidIds) store.delete(id);
				store.put(record);
			} catch (error) {
				transaction.abort();
				await waitForTransaction(transaction, "保存本地资源失败。").catch(() => undefined);
				throw error;
			}
			await waitForTransaction(transaction, "保存本地资源失败。");
		},
		async remove(ids) {
			if (ids.length === 0) return;
			const transaction = database.transaction(STORE_NAME, "readwrite");
			const store = transaction.objectStore(STORE_NAME);
			for (const id of ids) store.delete(id);
			await waitForTransaction(transaction, "清理本地资源失败。");
		},
		async migrateLegacy(key, prepare) {
			const transaction = database.transaction([LEGACY_STORE_NAME, STORE_NAME], "readwrite");
			const legacyStore = transaction.objectStore(LEGACY_STORE_NAME);
			const assetStore = transaction.objectStore(STORE_NAME);
			let migrated: LocalStagedAssetRecord | undefined;
			try {
				const rawLegacy = await runRequest(legacyStore.get(key), "读取旧版本地图片失败。");
				const rawRecords = await runRequest(assetStore.getAll(), "读取本地资源暂存区失败。");
				const prepared = prepare(rawLegacy, rawRecords);
				for (const id of prepared.invalidIds) assetStore.delete(id);
				if (prepared.record) {
					assetStore.put(prepared.record);
					migrated = prepared.record;
				}
				if (prepared.removeLegacy) legacyStore.delete(key);
			} catch (error) {
				transaction.abort();
				await waitForTransaction(transaction, "迁移旧版本地图片失败。").catch(() => undefined);
				throw error;
			}
			await waitForTransaction(transaction, "迁移旧版本地图片失败。");
			return migrated;
		},
		async deleteLegacy(key, recordId) {
			const transaction = database.transaction([LEGACY_STORE_NAME, STORE_NAME], "readwrite");
			transaction.objectStore(STORE_NAME).delete(recordId);
			transaction.objectStore(LEGACY_STORE_NAME).delete(key);
			await waitForTransaction(transaction, "清理旧版本地图片失败。");
		},
		close() {
			database.close();
		},
	};
}

async function withStorage<T>(
	dependencies: LocalMediaStorageDependencies,
	operation: (storage: LocalMediaRecordStorage) => Promise<T>,
): Promise<T | null> {
	const storage = await (dependencies.openStorage ?? openIndexedDbStorage)();
	if (!storage) return null;
	try {
		return await operation(storage);
	} finally {
		storage.close();
	}
}

function normalizeRecords(
	rawRecords: readonly unknown[],
	options: { draftKey?: string; maxAgeMs: number; now: Date },
): LocalStagedAssetListResult & { invalidIds: string[] } {
	const records: LocalStagedAssetRecord[] = [];
	const invalidIds: string[] = [];
	let removedCorrupt = 0;
	let removedExpired = 0;
	for (const raw of rawRecords) {
		const rawId =
			typeof raw === "object" && raw !== null && "id" in raw
				? (raw as { id?: unknown }).id
				: undefined;
		const belongsToDraft =
			!options.draftKey || (typeof rawId === "string" && rawId.startsWith(`${options.draftKey}:`));
		if (!belongsToDraft) continue;
		let record: LocalStagedAssetRecord;
		try {
			record = parseLocalStagedAssetRecord(raw);
		} catch {
			removedCorrupt += 1;
			// IndexedDB 主键本身足以定向删除；无需让损坏记录再次通过完整记录正则。
			if (typeof rawId === "string") invalidIds.push(rawId);
			continue;
		}
		if (record.draftKey !== options.draftKey && options.draftKey) continue;
		if (options.now.getTime() - new Date(record.savedAt).getTime() > options.maxAgeMs) {
			removedExpired += 1;
			invalidIds.push(record.id);
			continue;
		}
		records.push(record);
	}
	records.sort((left, right) =>
		left.savedAt === right.savedAt
			? left.localId.localeCompare(right.localId)
			: left.savedAt.localeCompare(right.savedAt),
	);
	return { records, removedCorrupt, removedExpired, invalidIds };
}

export async function listLocalStagedAssets(
	draftKey: string,
	options: ListLocalStagedAssetsOptions = {},
): Promise<LocalStagedAssetListResult | null> {
	const parsedDraftKey = z.string().regex(DRAFT_KEY_PATTERN).parse(draftKey);
	const now = parseDate(options.now ?? new Date(), "本地暂存检查时间");
	const maxAgeMs = parseMaxAgeMs(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
	return withStorage(options, (storage) =>
		storage.clean((rawRecords) => {
			const normalized = normalizeRecords(rawRecords, {
				draftKey: parsedDraftKey,
				maxAgeMs,
				now,
			});
			return {
				invalidIds: normalized.invalidIds,
				result: {
					records: normalized.records,
					removedCorrupt: normalized.removedCorrupt,
					removedExpired: normalized.removedExpired,
				},
			};
		}),
	);
}

async function upsertParsedLocalStagedAsset(
	parsed: LocalStagedAssetRecord,
	dependencies: LocalMediaStorageDependencies,
): Promise<boolean> {
	const output = await withStorage(dependencies, async (storage) => {
		await storage.upsert(parsed, (rawRecords) => {
			const normalized = normalizeRecords(rawRecords, {
				draftKey: parsed.draftKey,
				maxAgeMs: DEFAULT_MAX_AGE_MS,
				now: new Date(),
			});
			const current = normalized.records.filter((entry) => entry.localId !== parsed.localId);
			if (current.length + 1 > ARTICLE_ASSET_MAX_COUNT) {
				throw new TypeError(`每篇草稿最多暂存 ${ARTICLE_ASSET_MAX_COUNT} 个资源。`);
			}
			const totalBytes = current.reduce((total, entry) => total + entry.size, parsed.size);
			if (totalBytes > ARTICLE_ASSET_TOTAL_MAX_BYTES) {
				throw new TypeError("单篇草稿的本地暂存资源总量超过上限。");
			}
			return normalized.invalidIds;
		});
		return true;
	});
	return output ?? false;
}

export async function upsertLocalStagedAsset(
	record: LocalStagedAssetRecord,
	dependencies: LocalMediaStorageDependencies = {},
): Promise<boolean> {
	const parsed = parseLocalStagedAssetRecord(record);
	parsePublicLocalId(parsed.localId);
	return upsertParsedLocalStagedAsset(parsed, dependencies);
}

export function createLocalStagedArticleAssetManifest(
	records: readonly LocalStagedAssetRecord[],
): LocalStagedArticleAssetManifest {
	const parsedRecords = records.map(parseLocalStagedAssetRecord);
	if (parsedRecords.filter((record) => record.role === "cover").length > 1) {
		throw new TypeError("每篇文章最多只能有一个封面资源。");
	}
	if (parsedRecords.some((record) => !record.r2)) {
		throw new TypeError("存在尚未上传到 R2 的本地资源，不能提交文章资源清单。");
	}
	return {
		version: 1,
		assets: parsedRecords
			.map((record) => {
				if (!record.r2) throw new TypeError("本地资源缺少 R2 暂存身份。");
				return {
					version: 1 as const,
					assetId: record.r2.assetId,
					objectKey: record.r2.objectKey,
					etag: record.r2.etag,
					originalFilename: record.filename,
					contentType: record.contentType,
					size: record.size,
					role: record.role,
				};
			})
			.sort((left, right) => left.objectKey.localeCompare(right.objectKey)),
	};
}

export async function removeLocalStagedAsset(
	draftKey: string,
	localId: string,
	dependencies: LocalMediaStorageDependencies = {},
): Promise<boolean> {
	const id = createRecordId(
		z.string().regex(DRAFT_KEY_PATTERN).parse(draftKey),
		parsePublicLocalId(localId),
	);
	const output = await withStorage(dependencies, async (storage) => {
		await storage.remove([id]);
		return true;
	});
	return output ?? false;
}

export async function clearExpiredLocalStagedAssets(
	options: Omit<ListLocalStagedAssetsOptions, "draftKey"> = {},
): Promise<{ removedCorrupt: number; removedExpired: number } | null> {
	const now = parseDate(options.now ?? new Date(), "本地暂存检查时间");
	const maxAgeMs = parseMaxAgeMs(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
	return withStorage(options, (storage) =>
		storage.clean((rawRecords) => {
			const normalized = normalizeRecords(rawRecords, { maxAgeMs, now });
			return {
				invalidIds: normalized.invalidIds,
				result: {
					removedCorrupt: normalized.removedCorrupt,
					removedExpired: normalized.removedExpired,
				},
			};
		}),
	);
}

export async function clearCommittedLocalStagedAssets(
	draftKey: string,
	localIds: readonly string[],
	dependencies: LocalMediaStorageDependencies = {},
): Promise<boolean> {
	const parsedDraftKey = z.string().regex(DRAFT_KEY_PATTERN).parse(draftKey);
	const uniqueIds = new Set(
		localIds.map((localId) => createRecordId(parsedDraftKey, parsePublicLocalId(localId))),
	);
	const output = await withStorage(dependencies, async (storage) => {
		await storage.remove([...uniqueIds]);
		return true;
	});
	return output ?? false;
}

function legacyToV2(record: LocalStagedMediaRecord): LocalStagedAssetRecord {
	return createLocalStagedAssetRecordInternal({
		draftKey: record.key,
		file: new File([record.blob], record.filename, { type: record.contentType }),
		localId: "legacy",
		now: new Date(record.savedAt),
		role: "inline",
	});
}

export async function saveLocalStagedMedia(
	record: LocalStagedMediaRecord,
	dependencies: LocalMediaStorageDependencies = {},
): Promise<boolean> {
	return upsertParsedLocalStagedAsset(
		legacyToV2(parseLocalStagedMediaRecord(record)),
		dependencies,
	);
}

export async function loadLocalStagedMedia(
	key: string,
	options: ListLocalStagedAssetsOptions = {},
): Promise<LocalStagedMediaRecord | null> {
	const parsedKey = z.string().regex(LEGACY_MEDIA_KEY_PATTERN).parse(key);
	const listed = await listLocalStagedAssets(parsedKey, options);
	if (listed === null) return null;
	// 旧单图 API 只拥有固定 legacy 槽位，不能读取未来多资源流程的图片或附件。
	let record = listed.records.find((entry) => entry.localId === "legacy");
	if (!record) {
		const now = parseDate(options.now ?? new Date(), "本地暂存检查时间");
		const maxAgeMs = parseMaxAgeMs(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
		const migrated = await withStorage(options, (storage) =>
			storage.migrateLegacy(parsedKey, (raw, rawRecords) => {
				if (raw === undefined) return { invalidIds: [], removeLegacy: false };
				let legacy: LocalStagedMediaRecord;
				try {
					legacy = parseLocalStagedMediaRecord(raw);
				} catch {
					return { invalidIds: [], removeLegacy: true };
				}
				if (now.getTime() - new Date(legacy.savedAt).getTime() > maxAgeMs) {
					return { invalidIds: [], removeLegacy: true };
				}
				const normalized = normalizeRecords(rawRecords, {
					draftKey: parsedKey,
					maxAgeMs,
					now,
				});
				const existingLegacy = normalized.records.find((entry) => entry.localId === "legacy");
				if (existingLegacy) {
					return {
						invalidIds: normalized.invalidIds,
						record: existingLegacy,
						removeLegacy: true,
					};
				}
				const v2 = legacyToV2(legacy);
				const current = normalized.records.filter((entry) => entry.localId !== "legacy");
				if (current.length + 1 > ARTICLE_ASSET_MAX_COUNT) {
					throw new TypeError(`每篇草稿最多暂存 ${ARTICLE_ASSET_MAX_COUNT} 个资源。`);
				}
				const totalBytes = current.reduce((total, entry) => total + entry.size, v2.size);
				if (totalBytes > ARTICLE_ASSET_TOTAL_MAX_BYTES) {
					throw new TypeError("单篇草稿的本地暂存资源总量超过上限。");
				}
				return {
					invalidIds: normalized.invalidIds,
					record: v2,
					removeLegacy: true,
				};
			}),
		);
		record = migrated ?? undefined;
	}
	if (!record) return null;
	return {
		version: LEGACY_RECORD_VERSION,
		key: parsedKey,
		filename: record.filename,
		contentType: z.enum(["image/jpeg", "image/png", "image/webp"]).parse(record.contentType),
		size: record.size,
		savedAt: record.savedAt,
		blob: record.blob,
	};
}

export async function deleteLocalStagedMedia(
	key: string,
	dependencies: LocalMediaStorageDependencies = {},
): Promise<boolean> {
	const parsedKey = z.string().regex(LEGACY_MEDIA_KEY_PATTERN).parse(key);
	const output = await withStorage(dependencies, async (storage) => {
		// 两个 Store 必须原子清理，避免并发迁移在删除间隙重新生成 v2 legacy。
		await storage.deleteLegacy(parsedKey, createRecordId(parsedKey, "legacy"));
		return true;
	});
	return output ?? false;
}

export const LOCAL_MEDIA_LIMITS = {
	attachmentBytes: ARTICLE_ASSET_ATTACHMENT_MAX_BYTES,
	imageBytes: ARTICLE_ASSET_IMAGE_MAX_BYTES,
	maxCount: ARTICLE_ASSET_MAX_COUNT,
	totalBytes: ARTICLE_ASSET_TOTAL_MAX_BYTES,
} as const;

export type LocalStagedAssetContentType = MediaStagingContentType;
