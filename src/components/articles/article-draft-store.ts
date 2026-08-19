import { z } from "zod";
import type { ArticleEditorForm } from "./article-editor-state";

const DATABASE_NAME = "firefly-admin";
const DATABASE_VERSION = 1;
const STORE_NAME = "article-drafts";
const DRAFT_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const DRAFT_KEY_PATTERN = /^(?:create|edit:[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const CREATE_MEDIA_DRAFT_ID_PATTERN = /^[a-f0-9-]{16,64}$/;
const CREATE_MEDIA_DRAFT_STORAGE_KEY = "firefly-admin:create-media-draft-id";

const persistedArticleFormSchema = z
	.object({
		storageSlug: z.string().max(100),
		publicSlug: z.string().max(100),
		title: z.string().max(200),
		published: z.string().max(64),
		updated: z.string().max(64),
		draft: z.boolean(),
		description: z.string().max(500),
		image: z.string().max(2_048),
		tags: z.string().max(2_000),
		category: z.string().max(100),
		lang: z.string().max(20),
		pinned: z.boolean(),
		author: z.string().max(100),
		sourceLink: z.string().max(2_048),
		licenseName: z.string().max(100),
		licenseUrl: z.string().max(2_048),
		comment: z.boolean(),
		markdown: z.string().max(1_000_000),
	})
	.strict();

const articleDraftRecordSchema = z
	.object({
		version: z.literal(DRAFT_VERSION),
		key: z.string().regex(DRAFT_KEY_PATTERN),
		savedAt: z.iso.datetime({ offset: true }),
		baseSha: z.string().regex(GIT_OBJECT_SHA).optional(),
		form: persistedArticleFormSchema,
	})
	.strict();

export type PersistedArticleForm = z.infer<typeof persistedArticleFormSchema>;
export type ArticleDraftRecord = z.infer<typeof articleDraftRecordSchema>;

interface LoadArticleDraftOptions {
	maxAgeMs?: number;
	now?: Date;
}

export interface BrowserKeyValueStorage {
	getItem(key: string): string | null;
	removeItem(key: string): void;
	setItem(key: string, value: string): void;
}

interface CreateMediaDraftIdOptions {
	createId?: () => string;
	storage?: BrowserKeyValueStorage;
}

/**
 * 草稿键按新建页和具体文章隔离。编辑模式必须使用服务端已校验过的 storage slug，
 * 避免把任意字符串变成 IndexedDB 键空间的一部分。
 */
export function createArticleDraftKey(mode: "create" | "edit", storageSlug?: string): string {
	const key = mode === "create" ? "create" : `edit:${storageSlug ?? ""}`;
	return z.string().regex(DRAFT_KEY_PATTERN).parse(key);
}

function getBrowserStorage(storage?: BrowserKeyValueStorage): BrowserKeyValueStorage | undefined {
	if (storage) return storage;
	return typeof localStorage === "undefined" ? undefined : localStorage;
}

/**
 * 新建文章的 storage slug 会随标题变化，不能作为媒体草稿身份。该随机 ID 保存在同源
 * localStorage，页面刷新后仍能找回同一批 IndexedDB 资源，但不包含正文、Token 或凭据。
 */
export function getOrCreateArticleMediaDraftId(options: CreateMediaDraftIdOptions = {}): string {
	const storage = getBrowserStorage(options.storage);
	const stored = storage?.getItem(CREATE_MEDIA_DRAFT_STORAGE_KEY);
	const parsedStored = z.string().regex(CREATE_MEDIA_DRAFT_ID_PATTERN).safeParse(stored);
	if (parsedStored.success) return parsedStored.data;
	if (stored !== null && stored !== undefined) storage?.removeItem(CREATE_MEDIA_DRAFT_STORAGE_KEY);

	const created = z
		.string()
		.regex(CREATE_MEDIA_DRAFT_ID_PATTERN)
		.parse((options.createId ?? crypto.randomUUID)());
	storage?.setItem(CREATE_MEDIA_DRAFT_STORAGE_KEY, created);
	return created;
}

/** 仅在值仍属于当前页面时清理，避免旧页面提交成功后删除另一页面新建的身份。 */
export function clearArticleMediaDraftId(
	expectedId: string,
	options: Pick<CreateMediaDraftIdOptions, "storage"> = {},
): boolean {
	const parsedExpected = z.string().regex(CREATE_MEDIA_DRAFT_ID_PATTERN).parse(expectedId);
	const storage = getBrowserStorage(options.storage);
	if (!storage || storage.getItem(CREATE_MEDIA_DRAFT_STORAGE_KEY) !== parsedExpected) return false;
	storage.removeItem(CREATE_MEDIA_DRAFT_STORAGE_KEY);
	return true;
}

/**
 * 本地草稿有意排除访问密码和密码提示。IndexedDB 是同源持久化存储，不是 Secret
 * 仓库；共享设备、浏览器扩展或同源 XSS 都可能读取其中的数据。
 */
export function createArticleDraftRecord(input: {
	baseSha?: string;
	form: ArticleEditorForm;
	key: string;
	now?: Date;
}): ArticleDraftRecord {
	const { password: _password, passwordHint: _passwordHint, ...persistedForm } = input.form;
	return articleDraftRecordSchema.parse({
		version: DRAFT_VERSION,
		key: input.key,
		savedAt: (input.now ?? new Date()).toISOString(),
		...(input.baseSha ? { baseSha: input.baseSha } : {}),
		form: persistedForm,
	});
}

export function parseArticleDraftRecord(input: unknown): ArticleDraftRecord {
	return articleDraftRecordSchema.parse(input);
}

/**
 * 恢复时保留当前远端文章中的敏感字段。这样既不会把密码写入 IndexedDB，也不会因
 * 恢复普通内容草稿而在下一次提交时意外清空远端密码。
 */
export function restoreArticleDraftForm(
	currentForm: ArticleEditorForm,
	draft: ArticleDraftRecord,
): ArticleEditorForm {
	return {
		...draft.form,
		password: currentForm.password,
		passwordHint: currentForm.passwordHint,
	};
}

function openDraftDatabase(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === "undefined") return Promise.resolve(null);

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME, { keyPath: "key" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("无法打开本地草稿数据库。"));
		request.onblocked = () => reject(new Error("本地草稿数据库升级被其他页面阻塞。"));
	});
}

function runRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("本地草稿操作失败。"));
	});
}

async function deleteFromDatabase(database: IDBDatabase, key: string): Promise<void> {
	const transaction = database.transaction(STORE_NAME, "readwrite");
	await runRequest(transaction.objectStore(STORE_NAME).delete(key));
}

/**
 * 读取边界始终重新执行 strict Schema，并忽略损坏、未来版本或过期记录。失败数据会被
 * 尽力删除，防止每次打开编辑器都重复触发恢复提示。
 */
export async function loadArticleDraft(
	key: string,
	options: LoadArticleDraftOptions = {},
): Promise<ArticleDraftRecord | null> {
	const parsedKey = z.string().regex(DRAFT_KEY_PATTERN).parse(key);
	const database = await openDraftDatabase();
	if (!database) return null;

	try {
		const transaction = database.transaction(STORE_NAME, "readonly");
		const raw = await runRequest(transaction.objectStore(STORE_NAME).get(parsedKey));
		if (raw === undefined) return null;

		const result = articleDraftRecordSchema.safeParse(raw);
		const now = options.now ?? new Date();
		const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
		const expired =
			result.success && now.getTime() - new Date(result.data.savedAt).getTime() > maxAgeMs;
		if (!result.success || expired) {
			await deleteFromDatabase(database, parsedKey);
			return null;
		}
		return result.data;
	} finally {
		database.close();
	}
}

/** 返回 false 表示当前环境没有 IndexedDB；运行时错误交给调用方降级并提示。 */
export async function saveArticleDraft(record: ArticleDraftRecord): Promise<boolean> {
	const parsed = articleDraftRecordSchema.parse(record);
	const database = await openDraftDatabase();
	if (!database) return false;

	try {
		const transaction = database.transaction(STORE_NAME, "readwrite");
		await runRequest(transaction.objectStore(STORE_NAME).put(parsed));
		return true;
	} finally {
		database.close();
	}
}

/** 返回 false 表示当前环境没有 IndexedDB，此时没有本地记录需要清理。 */
export async function deleteArticleDraft(key: string): Promise<boolean> {
	const parsedKey = z.string().regex(DRAFT_KEY_PATTERN).parse(key);
	const database = await openDraftDatabase();
	if (!database) return false;

	try {
		await deleteFromDatabase(database, parsedKey);
		return true;
	} finally {
		database.close();
	}
}
