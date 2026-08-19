import { describe, expect, it } from "vitest";
import {
	parseCommittedMediaPayload,
	parseMediaStagingPayload,
} from "../../src/components/articles/media-staging";
import { resolveAdminCapabilities } from "../../src/core/config/capabilities";
import {
	createLocalPreviewPrincipal,
	handleLocalPreviewApiRequest as handleLocalPreviewApiRequestWithCapabilities,
	isLocalPreviewRequest,
} from "../../src/core/local-preview";

const previewEnv = { APP_ENV: "development", LOCAL_PREVIEW: "true" };
const previewCapabilities = resolveAdminCapabilities({});

function handleLocalPreviewApiRequest(request: Request): Promise<Response | null> {
	return handleLocalPreviewApiRequestWithCapabilities(request, previewCapabilities);
}

function createWriteRequest(url: string, method: "POST" | "PUT", body: unknown): Request {
	return new Request(url, {
		method,
		headers: {
			"Content-Type": "application/json",
			Origin: "http://localhost:4321",
			"Sec-Fetch-Site": "same-origin",
			"X-Firefly-Admin": "1",
		},
		body: JSON.stringify(body),
	});
}

describe("仅开发环境本地预览", () => {
	it("只允许显式 development HTTP loopback 且拒绝 Cloudflare 边缘请求", () => {
		expect(isLocalPreviewRequest(new Request("http://localhost:4321/articles"), previewEnv)).toBe(
			true,
		);
		expect(isLocalPreviewRequest(new Request("http://127.0.0.1:4321/articles"), previewEnv)).toBe(
			true,
		);
		expect(isLocalPreviewRequest(new Request("https://localhost:4321/articles"), previewEnv)).toBe(
			false,
		);
		expect(isLocalPreviewRequest(new Request("http://dev.example.com/articles"), previewEnv)).toBe(
			false,
		);
		expect(
			isLocalPreviewRequest(new Request("http://localhost:4321/articles"), {
				APP_ENV: "production",
				LOCAL_PREVIEW: "true",
			}),
		).toBe(false);
		expect(
			isLocalPreviewRequest(new Request("http://localhost:4321/articles"), {
				APP_ENV: "development",
			}),
		).toBe(false);
		expect(
			isLocalPreviewRequest(
				new Request("http://localhost:4321/articles", {
					headers: { "CF-Connecting-IP": "203.0.113.10" },
				}),
				previewEnv,
			),
		).toBe(false);
	});

	it("使用固定非特权预览主体", () => {
		expect(createLocalPreviewPrincipal()).toEqual({
			sub: "local-preview-user",
			email: "preview@localhost",
		});
	});

	it("返回可通过浏览器 strict Schema 的文章列表与详情 fixture", async () => {
		const list = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/articles?page=1&pageSize=20"),
		);
		expect(list?.status).toBe(200);
		expect(list?.headers.get("X-Firefly-Local-Preview")).toBe("true");
		expect((await list?.json()) as { articles: { items: unknown[] } }).toMatchObject({
			articles: { total: 2, page: 1 },
		});

		const detail = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/articles/hello-firefly"),
		);
		expect(detail?.status).toBe(200);
		expect(await detail?.json()).toMatchObject({
			article: { storageSlug: "hello-firefly", format: "md", sha: "a".repeat(40) },
		});

		const missing = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/articles/missing-article"),
		);
		expect(missing?.status).toBe(404);
		expect(await missing?.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
	});

	it("slug HEAD 预检区分占用与可用", async () => {
		const occupied = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/articles/hello-firefly", { method: "HEAD" }),
		);
		const available = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/articles/new-article", { method: "HEAD" }),
		);
		expect(occupied?.status).toBe(200);
		expect(available?.status).toBe(404);
		expect(available?.headers.get("X-Article-Slug-Available")).toBe("true");
	});

	it("模拟 R2 暂存返回严格响应但不访问外部服务", async () => {
		const body = new FormData();
		body.set("file", new File([new Uint8Array([1, 2, 3])], "preview.png", { type: "image/png" }));
		const response = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/media/staging", {
				method: "POST",
				headers: {
					Origin: "http://localhost:4321",
					"Sec-Fetch-Site": "same-origin",
					"X-Firefly-Admin": "1",
				},
				body,
			}),
		);

		expect(response?.status).toBe(201);
		expect(response?.headers.get("X-Firefly-Local-Preview")).toBe("true");
		expect(parseMediaStagingPayload(await response?.json())).toMatchObject({
			filename: "preview.png",
			contentType: "image/png",
			size: 3,
		});
	});

	it("模拟暂存图片转存并返回严格文章相对路径", async () => {
		const response = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/media/staging/commit", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": "media-commit-key-0001",
					Origin: "http://localhost:4321",
					"Sec-Fetch-Site": "same-origin",
					"X-Firefly-Admin": "1",
				},
				body: JSON.stringify({
					storageSlug: "hello-firefly",
					objectKey: `staging/2026/08/00000000-0000-4000-8000-000000000001.png`,
					etag: "preview-etag",
				}),
			}),
		);
		expect(response?.status).toBe(201);
		expect(parseCommittedMediaPayload(await response?.json())).toMatchObject({
			storageSlug: "hello-firefly",
			relativePath: "./preview-upload-000000000000.png",
		});
	});

	it("关闭的高级能力在本地预览同样失败关闭", async () => {
		const repository = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/repository/tree", { method: "GET" }),
		);
		expect(repository?.status).toBe(404);
		expect(await repository?.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

		const rename = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/media/transactions/preview", {
				method: "POST",
			}),
		);
		expect(rename?.status).toBe(404);
	});

	it("文章删除 fixture 服从能力快照", async () => {
		const disabled = await handleLocalPreviewApiRequestWithCapabilities(
			new Request("http://localhost:4321/api/articles/hello-firefly", {
				method: "DELETE",
			}),
			resolveAdminCapabilities({ FEATURE_ARTICLE_DELETE: "false" }),
		);
		expect(disabled?.status).toBe(404);

		const enabled = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/articles/hello-firefly", {
				method: "DELETE",
			}),
		);
		expect(enabled?.status).toBe(200);
		expect(await enabled?.json()).toMatchObject({
			deletion: { storageSlug: "hello-firefly", deletedFiles: expect.any(Array) },
		});
	});

	it("站内链接 fixture 服从同一能力快照", async () => {
		const disabled = await handleLocalPreviewApiRequestWithCapabilities(
			new Request("http://localhost:4321/api/articles/link-targets"),
			resolveAdminCapabilities({ FEATURE_ARTICLE_LINKS: "false" }),
		);
		expect(disabled?.status).toBe(404);

		const enabled = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/articles/link-targets"),
		);
		expect(enabled?.status).toBe(200);

		for (const search of ["?page=1", "?query=a&query=b", `?query=${"a".repeat(101)}`]) {
			const invalid = await handleLocalPreviewApiRequest(
				new Request(`http://localhost:4321/api/articles/link-targets${search}`),
			);
			expect(invalid?.status, search).toBe(400);
		}
	});

	it("未模拟的 API 在预览层失败关闭而不进入真实路由", async () => {
		const response = await handleLocalPreviewApiRequest(
			new Request("http://localhost:4321/api/deployments", { method: "POST" }),
		);
		expect(response?.status).toBe(404);
		expect(await response?.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
	});

	it("模拟写入仍强制同源策略和发布语义但不访问外部服务", async () => {
		const article = {
			frontmatter: { title: "Preview", draft: false },
			format: "md",
			markdown: "# Preview",
		};
		const response = await handleLocalPreviewApiRequest(
			createWriteRequest("http://localhost:4321/api/articles", "POST", {
				storageSlug: "preview-post",
				article,
				action: "publish",
			}),
		);
		expect(response?.status).toBe(201);
		expect(await response?.json()).toMatchObject({
			article: {
				storageSlug: "preview-post",
				commitUrl: expect.stringContaining("https://github.com/firefly-preview/local/commit/"),
			},
		});

		await expect(
			handleLocalPreviewApiRequest(
				new Request("http://localhost:4321/api/articles", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ storageSlug: "preview-post", article, action: "draft" }),
				}),
			),
		).rejects.toMatchObject({ status: 403, code: "ORIGIN_FORBIDDEN" });
	});
});

describe("preview proxy boundary", () => {
	it("rejects forwarded requests even when the URL is loopback", () => {
		for (const header of ["Forwarded", "Via", "X-Forwarded-For", "X-Real-IP"]) {
			expect(
				isLocalPreviewRequest(
					new Request("http://localhost:4321/articles", {
						headers: { [header]: "203.0.113.10" },
					}),
					{ APP_ENV: "development", LOCAL_PREVIEW: "true" },
				),
			).toBe(false);
		}
	});
});
