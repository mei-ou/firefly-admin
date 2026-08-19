import { z } from "zod";
import { parseMediaTransactionCommitRequest } from "../modules/media/media-transaction-commit";
import {
	type MediaTransactionPreview,
	parseRenameMediaTransactionPreviewRequest,
} from "../modules/media/media-transaction-preview";
import type { AdminCapabilitySnapshot } from "../types/capability";
import { jsonResponse } from "./http/response";
import { enforceWriteRequestPolicy } from "./security/origin-policy";

const LOCAL_PREVIEW_SUBJECT = "local-preview-user";
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PREVIEW_FILE_SHA = "a".repeat(40);
const PREVIEW_COMMIT_SHA = "b".repeat(40);
const PREVIEW_RESOURCE_SHA = "c".repeat(40);
const PREVIEW_MEDIA_ID = "00000000-0000-4000-8000-000000000001";
const PREVIEW_TRANSACTION_ID = "preview_local_000000000001";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORWARDED_REQUEST_HEADERS = ["Forwarded", "Via", "X-Forwarded-For", "X-Real-IP"] as const;
const PREVIEW_MEDIA_EXTENSIONS = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
} as const;

const previewMediaCommitSchema = z
	.object({
		storageSlug: z.string().regex(SLUG_PATTERN),
		objectKey: z.string().regex(/^staging\/\d{4}\/\d{2}\/[a-f0-9-]{16,64}\.(?:jpg|png|webp)$/i),
		etag: z.string().min(1).max(500),
	})
	.strict();

const previewWriteSchema = z.looseObject({
	storageSlug: z.string().regex(SLUG_PATTERN).optional(),
	expectedSha: z.string().optional(),
	article: z.looseObject({
		frontmatter: z.looseObject({
			title: z.string().min(1),
			draft: z.boolean(),
		}),
		slug: z.string().regex(SLUG_PATTERN).optional(),
		format: z.literal("md"),
		markdown: z.string(),
	}),
	action: z.enum(["draft", "publish"]),
});

const previewArticleMarkdown = new Map([
	[
		"hello-firefly",
		"# 本地预览正文\n\n## 快速开始\n\n这是一篇只存在于本地预览中的示例文章。\n\n![示例封面](./cover.webp)\n\n### 安全边界\n\n- 不读取 GitHub Token\n- 不写入 D1\n- 不触发 Cloudflare 构建\n",
	],
	[
		"security-boundary",
		"# 后台安全边界说明\n\n## 失败关闭\n\n安全配置缺失时拒绝继续。\n\n## 审计与并发\n\n写入操作保留审计和乐观锁。\n",
	],
]);

const previewArticles = [
	{
		storageSlug: "hello-firefly",
		slug: "hello-firefly",
		title: "你好，Firefly Admin",
		published: "2026-08-12T02:00:00.000Z",
		updated: "2026-08-12T08:30:00.000Z",
		draft: false,
		description: "用于本地预览文章列表、编辑器和发布状态的示例文章。",
		tags: ["Firefly", "Preview"],
		category: "Guide",
		pinned: true,
	},
	{
		storageSlug: "security-boundary",
		title: "后台安全边界说明",
		published: "2026-08-11T03:00:00.000Z",
		draft: true,
		description: "演示草稿状态、标签和编辑器 Frontmatter。",
		tags: ["Security", "Cloudflare"],
		category: "Engineering",
		pinned: false,
	},
] as const;

function readEnvironmentValue(environment: unknown, key: string): unknown {
	return typeof environment === "object" && environment !== null
		? Reflect.get(environment, key)
		: undefined;
}

/**
 * 本地预览必须同时满足显式开关、development、HTTP loopback 和非 Cloudflare 边缘请求。
 * 任一条件缺失都返回 false，生产部署即使误设其中一个变量也不会绕过 Access。
 */
export function isLocalPreviewRequest(request: Request, environment: unknown): boolean {
	const url = new URL(request.url);
	return (
		readEnvironmentValue(environment, "APP_ENV") === "development" &&
		readEnvironmentValue(environment, "LOCAL_PREVIEW") === "true" &&
		url.protocol === "http:" &&
		LOOPBACK_HOSTS.has(url.hostname) &&
		!["CF-Connecting-IP", ...FORWARDED_REQUEST_HEADERS].some((header) =>
			request.headers.has(header),
		)
	);
}

export function createLocalPreviewPrincipal(): { sub: string; email: string } {
	return { sub: LOCAL_PREVIEW_SUBJECT, email: "preview@localhost" };
}

function createPreviewDetail(storageSlug: string) {
	const summary = previewArticles.find((article) => article.storageSlug === storageSlug);
	const filename = storageSlug === "hello-firefly" ? "cover.webp" : "diagram.png";
	const role = storageSlug === "hello-firefly" ? "inline" : null;
	const reference =
		storageSlug === "hello-firefly"
			? {
					storageSlug,
					source: "markdown-image" as const,
					originalReference: "![示例封面](./cover.webp)",
					target: "./cover.webp",
					line: 7,
					column: 8,
				}
			: null;
	return {
		storageSlug,
		pathAlias: `${storageSlug}/index.md`,
		sha: PREVIEW_FILE_SHA,
		headSha: PREVIEW_COMMIT_SHA,
		resources: [
			{
				assetId: `preview-resource-${storageSlug}`,
				storageSlug,
				filename,
				relativePath: `./${filename}`,
				repositoryPath: `src/content/posts/${storageSlug}/${filename}`,
				blobSha: PREVIEW_RESOURCE_SHA,
				size: 1_024,
				contentType: filename.endsWith(".webp") ? "image/webp" : "image/png",
				role,
				kind: "image" as const,
				references: reference ? [reference] : [],
				policyLevel: reference ? ("L1" as const) : ("L0" as const),
				riskLevel: reference ? ("medium" as const) : ("low" as const),
				mutable: true,
				requiresImpactPreview: reference !== null,
				riskReasons: reference ? (["resource-reference"] as const) : [],
			},
		],
		resourceReferenceAnalysis: { complete: true, issues: [] },
		frontmatter: {
			title: summary?.title ?? "本地预览文章",
			published: summary?.published ?? "2026-08-12T02:00:00.000Z",
			...(summary && "updated" in summary ? { updated: summary.updated } : {}),
			draft: summary?.draft ?? true,
			description: summary?.description ?? "此内容仅存在于本地预览响应中。",
			image: "",
			tags: summary ? [...summary.tags] : ["Preview"],
			category: summary?.category ?? null,
			lang: "zh_CN",
			pinned: summary?.pinned ?? false,
			author: "小萤",
			sourceLink: "",
			licenseName: "",
			licenseUrl: "",
			comment: true,
			password: "",
			passwordHint: "",
		},
		...(summary && "slug" in summary ? { slug: summary.slug } : {}),
		format: "md" as const,
		markdown: previewArticleMarkdown.get(storageSlug) ?? "# 本地预览正文\n",
	};
}

function previewResponse(data: unknown, status = 200): Response {
	const response = jsonResponse(data, status);
	response.headers.set("X-Firefly-Local-Preview", "true");
	return response;
}

function disabledCapabilityResponse(): Response {
	return previewResponse({ error: { code: "NOT_FOUND", message: "资源不存在。" } }, 404);
}

async function handlePreviewMediaUpload(request: Request): Promise<Response> {
	enforceWriteRequestPolicy(request, new URL(request.url).origin, {
		contentTypes: ["multipart/form-data"],
	});
	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return previewResponse({ error: { code: "INVALID_REQUEST", message: "上传表单无效。" } }, 400);
	}
	const file = formData.get("file");
	const fields = Array.from(formData.keys());
	if (!(file instanceof File) || fields.length !== 1 || formData.getAll("file").length !== 1) {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "上传表单必须只包含一个文件。" } },
			400,
		);
	}
	const contentType = file.type as keyof typeof PREVIEW_MEDIA_EXTENSIONS;
	const extension = PREVIEW_MEDIA_EXTENSIONS[contentType];
	if (!extension || file.size === 0 || file.size > 1024 * 1024) {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "预览图片格式或大小无效。" } },
			415,
		);
	}
	return previewResponse(
		{
			asset: {
				id: PREVIEW_MEDIA_ID,
				objectKey: `staging/2026/08/${PREVIEW_MEDIA_ID}.${extension}`,
				filename: file.name.slice(0, 255) || "preview-upload",
				contentType,
				size: file.size,
				etag: "preview-etag",
				uploadedAt: "2026-08-13T10:00:00.000Z",
			},
		},
		201,
	);
}

async function handlePreviewMediaCommit(request: Request): Promise<Response> {
	enforceWriteRequestPolicy(request, new URL(request.url).origin);
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "请求 JSON 无效。" } },
			400,
		);
	}
	const result = previewMediaCommitSchema.safeParse(raw);
	if (!result.success || !request.headers.has("Idempotency-Key")) {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "媒体转存请求无效。" } },
			400,
		);
	}
	const extension = result.data.objectKey.split(".").at(-1) ?? "png";
	const filename = `preview-upload-${PREVIEW_MEDIA_ID.replaceAll("-", "").slice(0, 12)}.${extension}`;
	return previewResponse(
		{
			asset: {
				storageSlug: result.data.storageSlug,
				repositoryPath: `src/content/posts/${result.data.storageSlug}/${filename}`,
				relativePath: `./${filename}`,
				commitSha: PREVIEW_COMMIT_SHA,
				commitUrl: `https://github.com/firefly-preview/local/commit/${PREVIEW_COMMIT_SHA}`,
				fileSha: PREVIEW_FILE_SHA,
			},
		},
		201,
	);
}

function createLocalTransactionPreview(
	request: ReturnType<typeof parseRenameMediaTransactionPreviewRequest>,
): MediaTransactionPreview {
	const createdAt = "2026-08-17T10:00:00.000Z";
	const expiresAt = "2099-08-17T10:10:00.000Z";
	return {
		version: 1,
		previewId: PREVIEW_TRANSACTION_ID,
		operation: "rename",
		storageSlug: request.storageSlug,
		createdAt,
		expiresAt,
		baseCommitSha: request.expectedHeadSha,
		expectedArticleSha: request.expectedArticleSha,
		expectedBlobSha: request.expectedBlobSha,
		source: {
			filename: request.sourceFilename,
			relativePath: `./${request.sourceFilename}`,
			repositoryPath: `src/content/posts/${request.storageSlug}/${request.sourceFilename}`,
		},
		destination: {
			filename: request.destinationFilename,
			relativePath: `./${request.destinationFilename}`,
			repositoryPath: `src/content/posts/${request.storageSlug}/${request.destinationFilename}`,
		},
		effects: [
			{
				type: "resource-reuse",
				repositoryPath: `src/content/posts/${request.storageSlug}/${request.destinationFilename}`,
				from: null,
				to: request.expectedBlobSha,
			},
			{
				type: "resource-delete",
				repositoryPath: `src/content/posts/${request.storageSlug}/${request.sourceFilename}`,
				from: request.expectedBlobSha,
				to: null,
			},
		],
		references: [],
		referenceAnalysis: { complete: true, issues: [] },
		policyLevel: "L0",
		riskLevel: "low",
		riskReasons: [],
		confirmation: { kind: "button" },
	};
}

async function handlePreviewMediaTransactionPreview(request: Request): Promise<Response> {
	enforceWriteRequestPolicy(request, new URL(request.url).origin);
	try {
		const command = parseRenameMediaTransactionPreviewRequest(await request.json());
		return previewResponse({ preview: createLocalTransactionPreview(command) });
	} catch {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "媒体事务 Preview 请求无效。" } },
			400,
		);
	}
}

async function handlePreviewMediaTransactionCommit(request: Request): Promise<Response> {
	enforceWriteRequestPolicy(request, new URL(request.url).origin);
	if (!request.headers.has("Idempotency-Key")) {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "媒体事务 Commit 缺少幂等键。" } },
			400,
		);
	}
	try {
		const command = parseMediaTransactionCommitRequest(await request.json());
		if (command.previewId !== PREVIEW_TRANSACTION_ID) throw new TypeError("Preview 不匹配。");
		return previewResponse({
			transaction: {
				version: 1,
				operation: "rename",
				previewId: command.previewId,
				commitSha: PREVIEW_COMMIT_SHA,
				url: `https://github.com/firefly-preview/local/commit/${PREVIEW_COMMIT_SHA}`,
				article: { updated: false, fileSha: PREVIEW_FILE_SHA },
				source: { deleted: true },
				destination: { blobSha: PREVIEW_RESOURCE_SHA },
				completedAt: "2026-08-17T10:01:00.000Z",
			},
		});
	} catch {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "媒体事务 Commit 请求无效。" } },
			400,
		);
	}
}

async function handlePreviewWrite(request: Request, routeSlug?: string): Promise<Response> {
	enforceWriteRequestPolicy(request, new URL(request.url).origin);
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "请求 JSON 无效。" } },
			400,
		);
	}
	const result = previewWriteSchema.safeParse(raw);
	if (!result.success) {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "预览提交格式无效。" } },
			400,
		);
	}
	const storageSlug = routeSlug ?? result.data.storageSlug;
	if (!storageSlug || !SLUG_PATTERN.test(storageSlug)) {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "storage slug 无效。" } },
			400,
		);
	}
	if (result.data.action === "publish" && result.data.article.frontmatter.draft) {
		return previewResponse(
			{ error: { code: "INVALID_REQUEST", message: "正式发布时文章不能标记为草稿。" } },
			400,
		);
	}

	return previewResponse(
		{
			article: {
				storageSlug,
				pathAlias: `${storageSlug}/index.md`,
				commitSha: PREVIEW_COMMIT_SHA,
				commitUrl: `https://github.com/firefly-preview/local/commit/${PREVIEW_COMMIT_SHA}`,
				fileSha: PREVIEW_FILE_SHA,
			},
		},
		request.method === "POST" ? 201 : 200,
	);
}

/**
 * 拦截文章、媒体暂存和只读仓库浏览 API，为本地 UI 提供内存 fixture。返回 null 表示交还
 * 真实路由；本函数不访问 GitHub、R2、D1 或 Rate Limiter，也不会把模拟数据写入磁盘。
 */
export async function handleLocalPreviewApiRequest(
	request: Request,
	capabilities: AdminCapabilitySnapshot,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname === "/api/media/staging" && request.method === "POST") {
		if (!capabilities.smallImageUpload && !capabilities.pdfAttachmentUpload) {
			return disabledCapabilityResponse();
		}
		return handlePreviewMediaUpload(request);
	}
	if (url.pathname === "/api/media/staging/commit" && request.method === "POST") {
		if (!capabilities.smallImageUpload && !capabilities.pdfAttachmentUpload) {
			return disabledCapabilityResponse();
		}
		return handlePreviewMediaCommit(request);
	}
	if (url.pathname === "/api/media/transactions/preview" && request.method === "POST") {
		if (!capabilities.articleAssetRename) return disabledCapabilityResponse();
		return handlePreviewMediaTransactionPreview(request);
	}
	if (url.pathname === "/api/media/transactions/commit" && request.method === "POST") {
		if (!capabilities.articleAssetRename) return disabledCapabilityResponse();
		return handlePreviewMediaTransactionCommit(request);
	}
	if (url.pathname === "/api/repository/tree" && request.method === "GET") {
		if (!capabilities.repositoryBrowser) return disabledCapabilityResponse();
		const path = url.searchParams.get("path") ?? "";
		const directories: Record<
			string,
			Array<{ name: string; path: string; type: "file" | "directory" }>
		> = {
			"": [
				{ name: "src", path: "src", type: "directory" },
				{ name: "README.md", path: "README.md", type: "file" },
			],
			src: [{ name: "content", path: "src/content", type: "directory" }],
			"src/content": [{ name: "posts", path: "src/content/posts", type: "directory" }],
			"src/content/posts": previewArticles.map((article) => ({
				name: article.storageSlug,
				path: `src/content/posts/${article.storageSlug}`,
				type: "directory" as const,
			})),
			"src/content/posts/hello-firefly": [
				{ name: "cover.webp", path: "src/content/posts/hello-firefly/cover.webp", type: "file" },
				{ name: "index.md", path: "src/content/posts/hello-firefly/index.md", type: "file" },
			],
			"src/content/posts/security-boundary": [
				{
					name: "diagram.png",
					path: "src/content/posts/security-boundary/diagram.png",
					type: "file",
				},
				{ name: "index.md", path: "src/content/posts/security-boundary/index.md", type: "file" },
			],
		};
		const entries = directories[path];
		if (!entries) {
			return previewResponse({ error: { code: "NOT_FOUND", message: "预览目录不存在。" } }, 404);
		}
		const separatorIndex = path.lastIndexOf("/");
		return previewResponse({
			directory: {
				path,
				parentPath: path === "" ? null : separatorIndex < 0 ? "" : path.slice(0, separatorIndex),
				entries: entries.map((entry, index) => ({
					...entry,
					sha: (index % 2 === 0 ? "c" : "d").repeat(40),
				})),
			},
		});
	}

	if (!url.pathname.startsWith("/api/articles")) {
		return url.pathname.startsWith("/api/")
			? previewResponse({ error: { code: "NOT_FOUND", message: "本地预览未提供此接口。" } }, 404)
			: null;
	}

	if (url.pathname === "/api/articles/link-targets" && request.method === "GET") {
		if (!capabilities.articleLinks) return disabledCapabilityResponse();
		for (const key of url.searchParams.keys()) {
			if (key !== "query" || url.searchParams.getAll(key).length !== 1) {
				return previewResponse(
					{ error: { code: "INVALID_REQUEST", message: "文章链接查询参数无效。" } },
					400,
				);
			}
		}
		const query = url.searchParams.get("query")?.trim().toLowerCase() ?? "";
		if (query.length > 100) {
			return previewResponse(
				{ error: { code: "INVALID_REQUEST", message: "文章链接查询参数无效。" } },
				400,
			);
		}
		const items = previewArticles
			.filter((article) =>
				query.length === 0
					? true
					: [article.title, article.storageSlug, article.description, ...article.tags]
							.join(" ")
							.toLowerCase()
							.includes(query),
			)
			.map((article) => ({
				storageSlug: article.storageSlug,
				slug: "slug" in article ? article.slug : article.storageSlug,
				title: article.title,
				href: `/posts/${"slug" in article ? article.slug : article.storageSlug}/`,
				description: article.description,
				category: article.category,
				tags: [...article.tags],
				headings:
					article.storageSlug === "hello-firefly"
						? [
								{ depth: 2, text: "快速开始", id: "快速开始" },
								{ depth: 3, text: "安全边界", id: "安全边界" },
							]
						: [
								{ depth: 2, text: "失败关闭", id: "失败关闭" },
								{ depth: 2, text: "审计与并发", id: "审计与并发" },
							],
			}));
		return previewResponse({ targets: { items, truncated: false } });
	}

	if (url.pathname === "/api/articles" && request.method === "GET") {
		const query = url.searchParams.get("query")?.trim().toLowerCase() ?? "";
		const items = previewArticles.filter((article) =>
			query.length === 0
				? true
				: [article.title, article.storageSlug, article.description, ...article.tags]
						.join(" ")
						.toLowerCase()
						.includes(query),
		);
		return previewResponse({
			articles: {
				items,
				page: 1,
				pageSize: 20,
				total: items.length,
				totalPages: items.length === 0 ? 0 : 1,
				candidateCount: previewArticles.length,
				scanned: previewArticles.length,
				skipped: 0,
				truncated: false,
			},
		});
	}

	if (url.pathname === "/api/articles" && request.method === "POST") {
		return handlePreviewWrite(request);
	}

	const match = /^\/api\/articles\/([^/]+)$/.exec(url.pathname);
	if (!match) {
		return previewResponse(
			{ error: { code: "NOT_FOUND", message: "本地预览未提供此接口。" } },
			404,
		);
	}
	const storageSlug = decodeURIComponent(match[1] ?? "");
	if (!SLUG_PATTERN.test(storageSlug)) {
		return previewResponse({ error: { code: "INVALID_REQUEST", message: "slug 无效。" } }, 400);
	}
	const occupied = previewArticles.some((article) => article.storageSlug === storageSlug);
	if (request.method === "HEAD") {
		return new Response(null, {
			status: occupied ? 200 : 404,
			headers: {
				"Cache-Control": "no-store",
				"X-Article-Slug-Available": occupied ? "false" : "true",
				"X-Firefly-Local-Preview": "true",
			},
		});
	}
	if (request.method === "GET") {
		if (!occupied) {
			return previewResponse({ error: { code: "NOT_FOUND", message: "预览文章不存在。" } }, 404);
		}
		return previewResponse({ article: createPreviewDetail(storageSlug) });
	}
	if (request.method === "PUT") return handlePreviewWrite(request, storageSlug);
	if (request.method === "DELETE") {
		if (!capabilities.articleDelete) return disabledCapabilityResponse();
		if (!occupied) {
			return previewResponse({ error: { code: "NOT_FOUND", message: "预览文章不存在。" } }, 404);
		}
		return previewResponse({
			deletion: {
				storageSlug,
				pathAlias: `${storageSlug}/index.md`,
				commitSha: PREVIEW_COMMIT_SHA,
				commitUrl: `https://github.com/firefly-preview/local/commit/${PREVIEW_COMMIT_SHA}`,
				deletedFiles: [`${storageSlug}/index.md`, `${storageSlug}/preview-image-000000000001.webp`],
			},
		});
	}
	return previewResponse({ error: { code: "NOT_FOUND", message: "本地预览未提供此接口。" } }, 404);
}
