import { describe, expect, it, vi } from "vitest";
import {
	buildArticleWriteRequest,
	createEmptyArticleForm,
	createIdempotencyKey,
	formFromImportedMarkdown,
	formFromRemoteArticle,
	isValidStorageSlug,
	parseArticleCommitPayload,
	parseArticleDetailPayload,
	parseEditorApiError,
	parseRepositoryHeadSha,
	parseSlugAvailabilityStatus,
	suggestStorageSlug,
} from "../../src/components/articles/article-editor-state";

const FILE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const remoteArticle = {
	storageSlug: "hello-world",
	pathAlias: "hello-world/index.md",
	sha: FILE_SHA,
	headSha: HEAD_SHA,
	resources: [
		{
			assetId: `repository_${"d".repeat(40)}`,
			storageSlug: "hello-world",
			filename: "cover.webp",
			relativePath: "./cover.webp",
			repositoryPath: "src/content/posts/hello-world/cover.webp",
			blobSha: "d".repeat(40),
			size: 2_048,
			contentType: "image/webp",
			role: "cover",
			kind: "image",
			references: [
				{
					storageSlug: "hello-world",
					source: "frontmatter-image",
					originalReference: "./cover.webp",
					target: "./cover.webp",
					targetStorageSlug: "hello-world",
					targetFilename: "cover.webp",
					line: null,
					column: null,
				},
			],
			policyLevel: "L1",
			riskLevel: "high",
			mutable: true,
			requiresImpactPreview: true,
			riskReasons: ["cover-reference", "resource-reference"],
		},
	],
	resourceReferenceAnalysis: { complete: true, issues: [] },
	slug: "public-url",
	format: "md",
	markdown: "# 正文\n",
	frontmatter: {
		title: "你好，Firefly",
		published: "2026-08-12T00:00:00.000Z",
		updated: "2026-08-13T00:00:00.000Z",
		draft: true,
		description: "描述",
		image: "https://images.example/cover.webp",
		tags: ["Firefly", "安全"],
		category: "Guide",
		lang: "zh_CN",
		pinned: false,
		author: "Author",
		sourceLink: "https://source.example",
		licenseName: "CC BY 4.0",
		licenseUrl: "https://license.example",
		comment: true,
		password: "",
		passwordHint: "",
	},
};

describe("文章编辑器浏览器状态边界", () => {
	it("严格解析详情响应并拒绝路径或未知字段漂移", () => {
		expect(parseArticleDetailPayload({ article: remoteArticle })).toMatchObject({
			storageSlug: "hello-world",
			sha: FILE_SHA,
			headSha: HEAD_SHA,
		});
		expect(() =>
			parseArticleDetailPayload({
				article: { ...remoteArticle, headSha: undefined },
			}),
		).toThrow();
		expect(() =>
			parseArticleDetailPayload({
				article: { ...remoteArticle, pathAlias: "../secret.md" },
			}),
		).toThrow();
		expect(() =>
			parseArticleDetailPayload({
				article: { ...remoteArticle, repositoryPath: "src/content/posts/hello-world/index.md" },
			}),
		).toThrow();
		expect(() =>
			parseArticleDetailPayload({
				article: {
					...remoteArticle,
					resources: [{ ...remoteArticle.resources[0], filename: "../secret" }],
				},
			}),
		).toThrow();
	});

	it("将远端完整 Frontmatter 映射到表单且不丢失高级字段", () => {
		const form = formFromRemoteArticle(parseArticleDetailPayload({ article: remoteArticle }));
		expect(form).toMatchObject({
			storageSlug: "hello-world",
			publicSlug: "public-url",
			tags: "Firefly, 安全",
			sourceLink: "https://source.example",
			licenseName: "CC BY 4.0",
			markdown: "# 正文\n",
		});
	});

	it("安全映射导入文档并保持 storage slug 不变", () => {
		const current = createEmptyArticleForm(new Date("2026-08-12T00:00:00.000Z"));
		current.storageSlug = "repository-identity";
		const form = formFromImportedMarkdown(current, {
			slug: "public-url",
			markdown: "# 导入正文\n",
			frontmatter: {
				...remoteArticle.frontmatter,
				published: new Date(remoteArticle.frontmatter.published),
				updated: new Date(remoteArticle.frontmatter.updated),
			},
		});

		expect(form).toMatchObject({
			storageSlug: "repository-identity",
			publicSlug: "public-url",
			title: "你好，Firefly",
			markdown: "# 导入正文\n",
			tags: "Firefly, 安全",
		});
	});

	it("构造与服务端 strict Schema 对齐的完整写请求", () => {
		const form = formFromRemoteArticle(parseArticleDetailPayload({ article: remoteArticle }));
		form.title = " 更新后的标题 ";
		form.tags = " Firefly, 安全, ";

		const result = buildArticleWriteRequest(form);

		expect(result.storageSlug).toBe("hello-world");
		expect(result.article).toMatchObject({
			slug: "public-url",
			format: "md",
			markdown: "# 正文\n",
			frontmatter: {
				title: "更新后的标题",
				tags: ["Firefly", "安全"],
				category: "Guide",
				comment: true,
			},
		});
	});

	it("拒绝非法 storage/public slug、空标题和过多标签", () => {
		const createForm = createEmptyArticleForm(new Date("2026-08-12T00:00:00.000Z"));
		createForm.title = "Title";
		createForm.storageSlug = "../secret";
		expect(() => buildArticleWriteRequest(createForm)).toThrow("存储 slug");
		createForm.storageSlug = "hello-world";
		createForm.publicSlug = "Bad_Slug";
		expect(() => buildArticleWriteRequest(createForm)).toThrow("公开 slug");
		createForm.publicSlug = "";
		createForm.title = " ";
		expect(() => buildArticleWriteRequest(createForm)).toThrow("标题不能为空");
		createForm.title = "Title";
		createForm.tags = Array.from({ length: 31 }, (_, index) => `tag-${index}`).join(",");
		expect(() => buildArticleWriteRequest(createForm)).toThrow("标签不能超过 30 个");
	});

	it("从中英文标题生成经过长度收口的安全 storage slug 建议", () => {
		expect(suggestStorageSlug("你好 Firefly 管理后台")).toBe("ni-hao-firefly-guan-li-hou-tai");
		const longSuggestion = suggestStorageSlug("Firefly ".repeat(40));
		expect(longSuggestion.length).toBeLessThanOrEqual(100);
		expect(longSuggestion).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	});

	it("区分合法 storage slug 和 HEAD 预检结果三态", () => {
		expect(isValidStorageSlug("hello-world")).toBe(true);
		expect(isValidStorageSlug("Bad_Slug")).toBe(false);
		expect(isValidStorageSlug("a".repeat(101))).toBe(false);
		expect(parseSlugAvailabilityStatus(200)).toBe("occupied");
		expect(parseSlugAvailabilityStatus(404)).toBe("available");
		expect(parseSlugAvailabilityStatus(429)).toBe("unknown");
		expect(parseSlugAvailabilityStatus(503)).toBe("unknown");
	});

	it("只接受合法仓库 HEAD 响应头作为分支基线", () => {
		expect(parseRepositoryHeadSha(HEAD_SHA)).toBe(HEAD_SHA);
		expect(() => parseRepositoryHeadSha(null)).toThrow("HEAD 响应无效");
		expect(() => parseRepositoryHeadSha("main")).toThrow("HEAD 响应无效");
		expect(() => parseRepositoryHeadSha("A".repeat(40))).toThrow("HEAD 响应无效");
	});

	it("生成满足服务端幂等键契约的唯一键", () => {
		vi.stubGlobal("crypto", {
			randomUUID: vi.fn().mockReturnValue("123e4567-e89b-12d3-a456-426614174000"),
		});
		expect(createIdempotencyKey()).toBe("article-123e4567-e89b-12d3-a456-426614174000");
		vi.unstubAllGlobals();
	});

	it("严格解析提交结果并提供稳定错误信息", () => {
		const commit = {
			storageSlug: "hello-world",
			pathAlias: "hello-world/index.md",
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			fileSha: FILE_SHA,
			expectedArticleUrl: "https://blog.example.com/posts/public-url/",
		};
		expect(parseArticleCommitPayload({ article: commit })).toEqual(commit);
		expect(() =>
			parseArticleCommitPayload({
				article: { ...commit, commitUrl: `https://attacker.example/commit/${COMMIT_SHA}` },
			}),
		).toThrow();
		expect(() =>
			parseArticleCommitPayload({
				article: { ...commit, expectedArticleUrl: "javascript:alert(1)" },
			}),
		).toThrow();
		expect(parseEditorApiError({ error: { code: "CONFLICT", message: "请重新加载。" } }, 409)).toBe(
			"请重新加载。",
		);
		expect(parseEditorApiError(null, 409)).toContain("重新加载");
	});
});
