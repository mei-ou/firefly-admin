import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import { GitHubProvider } from "../../src/providers/git/github-provider";

const FILE_SHA = "a".repeat(40);
const NEXT_FILE_SHA = "b".repeat(40);
const COMMIT_SHA = "c".repeat(40);
const TREE_SHA = "d".repeat(40);
const NEXT_TREE_SHA = "e".repeat(40);
const ASSET_SHA = "f".repeat(40);
const repositoryPath = "src/content/posts/hello-world/index.md";

function createProvider(fetchMock: typeof fetch) {
	return new GitHubProvider(
		{
			owner: "firefly-owner",
			repo: "firefly-blog",
			branch: "master",
			token: "test-token-that-must-not-leak",
		},
		{ fetch: fetchMock },
	);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function getFetchCall(fetchMock: ReturnType<typeof vi.fn>): [URL, RequestInit] {
	const call = fetchMock.mock.calls[0];
	if (call === undefined) {
		throw new Error("预期 Provider 发起一次请求。");
	}
	return call as [URL, RequestInit];
}

describe("GitHubProvider 契约", () => {
	it("读取文件并将 GitHub base64 内容归一化为 UTF-8", async () => {
		const content = "# 你好，Firefly\n";
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				type: "file",
				path: repositoryPath,
				sha: FILE_SHA,
				encoding: "base64",
				content: Buffer.from(content, "utf8").toString("base64"),
				size: Buffer.byteLength(content),
			}),
		);

		const result = await createProvider(fetchMock).getFile(repositoryPath);

		expect(result).toEqual({
			path: repositoryPath,
			sha: FILE_SHA,
			content,
			encoding: "utf-8",
		});
		const [url, init] = getFetchCall(fetchMock);
		expect(url.origin).toBe("https://api.github.com");
		expect(url.pathname).toBe(
			"/repos/firefly-owner/firefly-blog/contents/src/content/posts/hello-world/index.md",
		);
		expect(url.searchParams.get("ref")).toBe("master");
		expect(init.method).toBe("GET");
	});

	it("读取 HEAD 时返回受信任的 Commit URL 和 Tree SHA", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: COMMIT_SHA } }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
					tree: { sha: TREE_SHA },
				}),
			);

		await expect(createProvider(fetchMock).getHead()).resolves.toEqual({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
			treeSha: TREE_SHA,
		});
	});

	it("列出仓库根目录且不产生尾随斜杠", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse([
				{ name: "src", path: "src", sha: FILE_SHA, type: "dir", size: 0 },
				{
					name: "README.md",
					path: "README.md",
					sha: NEXT_FILE_SHA,
					type: "file",
					size: 512,
				},
			]),
		);

		await expect(createProvider(fetchMock).listDirectory("")).resolves.toHaveLength(2);
		const [url] = getFetchCall(fetchMock);
		expect(url.pathname).toBe("/repos/firefly-owner/firefly-blog/contents");
		expect(url.searchParams.get("ref")).toBe("master");
	});

	it("列出目录时只返回归一化后的直接子项", async () => {
		const directoryPath = "src/content/posts";
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse([
				{
					name: "hello-world",
					path: `${directoryPath}/hello-world`,
					sha: FILE_SHA,
					type: "dir",
					size: 0,
					url: "https://api.github.com/ignored",
				},
				{
					name: "README.md",
					path: `${directoryPath}/README.md`,
					sha: NEXT_FILE_SHA,
					type: "file",
					size: 512,
				},
			]),
		);

		const result = await createProvider(fetchMock).listDirectory(directoryPath);

		expect(result).toEqual([
			{
				name: "hello-world",
				path: `${directoryPath}/hello-world`,
				sha: FILE_SHA,
				type: "directory",
				size: null,
			},
			{
				name: "README.md",
				path: `${directoryPath}/README.md`,
				sha: NEXT_FILE_SHA,
				type: "file",
				size: 512,
			},
		]);
		const [url, init] = getFetchCall(fetchMock);
		expect(url.pathname).toBe("/repos/firefly-owner/firefly-blog/contents/src/content/posts");
		expect(url.searchParams.get("ref")).toBe("master");
		expect(init.method).toBe("GET");
	});

	it("按不可变 Commit 列出目录快照", async () => {
		const directoryPath = "src/content/posts/hello-world";
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse([
				{
					name: "index.md",
					path: `${directoryPath}/index.md`,
					sha: FILE_SHA,
					type: "file",
					size: 1_024,
				},
				{
					name: "cover.webp",
					path: `${directoryPath}/cover.webp`,
					sha: ASSET_SHA,
					type: "file",
					size: 2_048,
				},
			]),
		);

		await expect(
			createProvider(fetchMock).listDirectoryAtCommit(directoryPath, COMMIT_SHA),
		).resolves.toHaveLength(2);
		const [url] = getFetchCall(fetchMock);
		expect(url.searchParams.get("ref")).toBe(COMMIT_SHA);
	});

	it("列目录快照时拒绝无效 Commit SHA 且不访问网络", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		await expect(
			createProvider(fetchMock).listDirectoryAtCommit("src/content/posts", "main"),
		).rejects.toThrow(TypeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("拒绝目录列表中的深层路径、重复名称和非直接子项", async () => {
		const directoryPath = "src/content/posts";
		const invalidBodies = [
			[
				{
					name: "hello-world",
					path: `${directoryPath}/hello-world/index.md`,
					sha: FILE_SHA,
					type: "file",
					size: 512,
				},
			],
			[
				{
					name: "hello-world",
					path: `${directoryPath}/hello-world`,
					sha: FILE_SHA,
					type: "dir",
					size: 0,
				},
				{
					name: "hello-world",
					path: `${directoryPath}/hello-world`,
					sha: NEXT_FILE_SHA,
					type: "dir",
					size: 0,
				},
			],
		];

		for (const body of invalidBodies) {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
			await expect(createProvider(fetchMock).listDirectory(directoryPath)).rejects.toMatchObject({
				status: 502,
				code: "UPSTREAM_ERROR",
			});
		}
	});

	it("拒绝超过目录响应上限的上游列表", async () => {
		const directoryPath = "src/content/posts";
		const body = Array.from({ length: 201 }, (_, index) => ({
			name: `post-${index}`,
			path: `${directoryPath}/post-${index}`,
			sha: FILE_SHA,
			type: "dir",
			size: 0,
		}));
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));

		await expect(createProvider(fetchMock).listDirectory(directoryPath)).rejects.toMatchObject({
			status: 502,
			code: "UPSTREAM_ERROR",
		});
	});

	it("把正文和二进制资源提交为一个 Tree、一个 Commit 和一次非强制 Ref 更新", async () => {
		const binaryPath = "src/content/posts/hello-world/cover.png";
		const checkpoint = vi.fn(async () => undefined);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: COMMIT_SHA } }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
					tree: { sha: TREE_SHA },
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ type: "file", path: repositoryPath, sha: FILE_SHA }))
			.mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
			.mockResolvedValueOnce(jsonResponse({ sha: NEXT_FILE_SHA }))
			.mockResolvedValueOnce(jsonResponse({ sha: ASSET_SHA }))
			.mockResolvedValueOnce(jsonResponse({ sha: NEXT_TREE_SHA }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: NEXT_FILE_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${NEXT_FILE_SHA}`,
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: NEXT_FILE_SHA } }));

		const result = await createProvider(fetchMock).commitFilesAtomically({
			expectedHeadSha: COMMIT_SHA,
			message: "docs(post): publish hello-world bundle",
			files: [
				{ path: repositoryPath, content: "# 新正文", expectedSha: FILE_SHA },
				{
					path: binaryPath,
					content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
					expectedSha: null,
				},
			],
			checkpointCandidateCommit: checkpoint,
		});

		expect(result.commitSha).toBe(NEXT_FILE_SHA);
		expect(result.files).toEqual([
			{ path: repositoryPath, fileSha: NEXT_FILE_SHA },
			{ path: binaryPath, fileSha: ASSET_SHA },
		]);
		expect(checkpoint).toHaveBeenCalledWith(NEXT_FILE_SHA);
		expect(fetchMock).toHaveBeenCalledTimes(9);
		const paths = fetchMock.mock.calls.map(([url]) => (url as URL).pathname);
		expect(paths).toEqual([
			"/repos/firefly-owner/firefly-blog/git/ref/heads/master",
			`/repos/firefly-owner/firefly-blog/git/commits/${COMMIT_SHA}`,
			`/repos/firefly-owner/firefly-blog/contents/${repositoryPath}`,
			`/repos/firefly-owner/firefly-blog/contents/${binaryPath}`,
			"/repos/firefly-owner/firefly-blog/git/blobs",
			"/repos/firefly-owner/firefly-blog/git/blobs",
			"/repos/firefly-owner/firefly-blog/git/trees",
			"/repos/firefly-owner/firefly-blog/git/commits",
			"/repos/firefly-owner/firefly-blog/git/refs/heads/master",
		]);
		const treePayload = JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body));
		expect(treePayload.base_tree).toBe(TREE_SHA);
		expect(treePayload.tree).toHaveLength(2);
		const commitPayload = JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body));
		expect(commitPayload.parents).toEqual([COMMIT_SHA]);
		const refPayload = JSON.parse(String(fetchMock.mock.calls[8]?.[1]?.body));
		expect(refPayload).toEqual({ sha: NEXT_FILE_SHA, force: false });
	});

	it("把已有资源删除与正文写入放入同一个 Tree，且删除不创建 Blob", async () => {
		const deletedPath = "src/content/posts/hello-world/old-guide.pdf";
		const deletedSha = "9".repeat(40);
		const checkpoint = vi.fn(async () => undefined);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: COMMIT_SHA } }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
					tree: { sha: TREE_SHA },
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ type: "file", path: repositoryPath, sha: FILE_SHA }))
			.mockResolvedValueOnce(jsonResponse({ type: "file", path: deletedPath, sha: deletedSha }))
			.mockResolvedValueOnce(jsonResponse({ sha: NEXT_FILE_SHA }))
			.mockResolvedValueOnce(jsonResponse({ sha: NEXT_TREE_SHA }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: ASSET_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${ASSET_SHA}`,
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: ASSET_SHA } }));

		const result = await createProvider(fetchMock).commitFilesAtomically({
			expectedHeadSha: COMMIT_SHA,
			message: "docs(post): remove old attachment",
			files: [
				{ path: repositoryPath, content: "# 新正文", expectedSha: FILE_SHA },
				{ operation: "delete", path: deletedPath, expectedSha: deletedSha },
			],
			checkpointCandidateCommit: checkpoint,
		});

		expect(result.files).toEqual([
			{ path: repositoryPath, fileSha: NEXT_FILE_SHA },
			{ path: deletedPath, fileSha: null },
		]);
		const paths = fetchMock.mock.calls.map(([url]) => (url as URL).pathname);
		expect(paths.filter((path) => path.endsWith("/git/blobs"))).toHaveLength(1);
		const treePayload = JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body));
		expect(treePayload.tree).toEqual([
			{ path: repositoryPath, mode: "100644", type: "blob", sha: NEXT_FILE_SHA },
			{ path: deletedPath, mode: "100644", type: "blob", sha: null },
		]);
		expect(checkpoint).toHaveBeenCalledWith(ASSET_SHA);
	});

	it("复用已锁定 Blob 完成无损重命名且不创建目标 Blob", async () => {
		const sourcePath = "src/content/posts/hello-world/old-name.pdf";
		const destinationPath = "src/content/posts/hello-world/new-name.pdf";
		const sourceSha = "9".repeat(40);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: COMMIT_SHA } }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
					tree: { sha: TREE_SHA },
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
			.mockResolvedValueOnce(jsonResponse({ type: "file", path: sourcePath, sha: sourceSha }))
			.mockResolvedValueOnce(jsonResponse({ sha: NEXT_TREE_SHA }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: ASSET_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${ASSET_SHA}`,
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: ASSET_SHA } }));

		const result = await createProvider(fetchMock).commitFilesAtomically({
			expectedHeadSha: COMMIT_SHA,
			message: "assets(post): rename attachment",
			files: [
				{ operation: "reuse", path: destinationPath, expectedSha: null, fileSha: sourceSha },
				{ operation: "delete", path: sourcePath, expectedSha: sourceSha },
			],
			checkpointCandidateCommit: async () => undefined,
		});

		expect(result.files).toEqual([
			{ path: destinationPath, fileSha: sourceSha },
			{ path: sourcePath, fileSha: null },
		]);
		const paths = fetchMock.mock.calls.map(([url]) => (url as URL).pathname);
		expect(paths.some((path) => path.endsWith("/git/blobs"))).toBe(false);
		const treePayload = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body));
		expect(treePayload.tree).toEqual([
			{ path: destinationPath, mode: "100644", type: "blob", sha: sourceSha },
			{ path: sourcePath, mode: "100644", type: "blob", sha: null },
		]);
	});

	it("复用目标已存在时在创建 Git 对象前冲突", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: COMMIT_SHA } }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
					tree: { sha: TREE_SHA },
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					type: "file",
					path: "src/content/posts/hello-world/new-name.pdf",
					sha: "8".repeat(40),
				}),
			);

		await expect(
			createProvider(fetchMock).commitFilesAtomically({
				expectedHeadSha: COMMIT_SHA,
				message: "assets(post): rename attachment",
				files: [
					{
						operation: "reuse",
						path: "src/content/posts/hello-world/new-name.pdf",
						expectedSha: null,
						fileSha: "9".repeat(40),
					},
				],
				checkpointCandidateCommit: async () => undefined,
			}),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("删除目标不存在或 SHA 不一致时在创建 Git 对象前冲突", async () => {
		const deletedPath = "src/content/posts/hello-world/old-guide.pdf";
		for (const response of [
			jsonResponse({ message: "Not Found" }, 404),
			jsonResponse({ type: "file", path: deletedPath, sha: "8".repeat(40) }),
		]) {
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: COMMIT_SHA } }))
				.mockResolvedValueOnce(
					jsonResponse({
						sha: COMMIT_SHA,
						html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
						tree: { sha: TREE_SHA },
					}),
				)
				.mockResolvedValueOnce(response);

			await expect(
				createProvider(fetchMock).commitFilesAtomically({
					expectedHeadSha: COMMIT_SHA,
					message: "docs(post): remove old attachment",
					files: [{ operation: "delete", path: deletedPath, expectedSha: "9".repeat(40) }],
					checkpointCandidateCommit: async () => undefined,
				}),
			).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
			expect(fetchMock).toHaveBeenCalledTimes(3);
		}
	});

	it("候选 Commit 检查点失败时绝不更新 Ref", async () => {
		const checkpoint = vi.fn(async () => {
			throw new Error("D1 unavailable");
		});
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: COMMIT_SHA } }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
					tree: { sha: TREE_SHA },
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
			.mockResolvedValueOnce(jsonResponse({ sha: NEXT_FILE_SHA }))
			.mockResolvedValueOnce(jsonResponse({ sha: NEXT_TREE_SHA }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: NEXT_FILE_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${NEXT_FILE_SHA}`,
				}),
			);

		await expect(
			createProvider(fetchMock).commitFilesAtomically({
				expectedHeadSha: COMMIT_SHA,
				message: "feat(post): add hello-world",
				files: [{ path: repositoryPath, content: "content", expectedSha: null }],
				checkpointCandidateCommit: checkpoint,
			}),
		).rejects.toThrow("D1 unavailable");
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
	});

	it("Ref 更新响应无法解析时返回结果未知且不自动二次提交", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ object: { type: "commit", sha: COMMIT_SHA } }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
					tree: { sha: TREE_SHA },
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
			.mockResolvedValueOnce(jsonResponse({ sha: NEXT_FILE_SHA }))
			.mockResolvedValueOnce(jsonResponse({ sha: NEXT_TREE_SHA }))
			.mockResolvedValueOnce(
				jsonResponse({
					sha: NEXT_FILE_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${NEXT_FILE_SHA}`,
				}),
			)
			.mockResolvedValueOnce(new Response("not-json", { status: 200 }));

		await expect(
			createProvider(fetchMock).commitFilesAtomically({
				expectedHeadSha: COMMIT_SHA,
				message: "feat(post): add hello-world",
				files: [{ path: repositoryPath, content: "content", expectedSha: null }],
				checkpointCandidateCommit: async () => undefined,
			}),
		).rejects.toMatchObject({ status: 503, code: "COMMIT_STATUS_UNKNOWN" });
		expect(fetchMock).toHaveBeenCalledTimes(7);
	});

	it("创建文件时由 Provider 固定仓库和分支并编码 UTF-8 内容", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				content: { path: repositoryPath, sha: NEXT_FILE_SHA },
				commit: {
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
				},
			}),
		);

		const result = await createProvider(fetchMock).createFile({
			path: repositoryPath,
			content: "---\ntitle: 你好\n---\n",
			message: "feat(post): add hello-world",
		});

		expect(result).toEqual({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
			fileSha: NEXT_FILE_SHA,
			filePath: repositoryPath,
		});
		const [, init] = getFetchCall(fetchMock);
		const body = JSON.parse(String(init.body)) as Record<string, string>;
		expect(init.method).toBe("PUT");
		expect(body.branch).toBe("master");
		expect(body.sha).toBeUndefined();
		expect(Buffer.from(body.content ?? "", "base64").toString("utf8")).toBe(
			"---\ntitle: 你好\n---\n",
		);
	});

	it("创建二进制文件时原样 base64 编码且不经过 UTF-8", async () => {
		const binaryPath = "src/content/posts/hello-world/cover.png";
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				content: { path: binaryPath, sha: NEXT_FILE_SHA },
				commit: {
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
				},
			}),
		);

		await createProvider(fetchMock).createBinaryFile({
			path: binaryPath,
			content: new Uint8Array([0x00, 0xff, 0x89, 0x50]),
			message: "assets(post): add hello-world/cover.png",
		});

		const [, init] = getFetchCall(fetchMock);
		const body = JSON.parse(String(init.body)) as Record<string, string>;
		expect(Buffer.from(body.content ?? "", "base64")).toEqual(
			Buffer.from([0x00, 0xff, 0x89, 0x50]),
		);
		expect(body.sha).toBeUndefined();
	});

	it("在发起请求前拒绝超过 1 MiB 的二进制文件", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		await expect(
			createProvider(fetchMock).createBinaryFile({
				path: "src/content/posts/hello-world/large.png",
				content: new Uint8Array(1024 * 1024 + 1),
				message: "assets(post): add hello-world/large.png",
			}),
		).rejects.toThrow("Git 文件内容超过大小限制");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("更新文件时原样携带调用方读取到的 Blob SHA", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				content: { path: repositoryPath, sha: NEXT_FILE_SHA },
				commit: {
					sha: COMMIT_SHA,
					html_url: `https://github.com/firefly-owner/firefly-blog/commit/${COMMIT_SHA}`,
				},
			}),
		);

		await createProvider(fetchMock).updateFile({
			path: repositoryPath,
			content: "updated",
			message: "docs(post): update hello-world",
			expectedSha: FILE_SHA,
		});

		const [, init] = getFetchCall(fetchMock);
		const body = JSON.parse(String(init.body)) as Record<string, string>;
		expect(body.sha).toBe(FILE_SHA);
	});

	it("将 GitHub 的 409 与 422 归一化为不强制覆盖的冲突", async () => {
		for (const status of [409, 422]) {
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValue(jsonResponse({ message: "sha does not match" }, status));

			await expect(
				createProvider(fetchMock).updateFile({
					path: repositoryPath,
					content: "updated",
					message: "docs(post): update hello-world",
					expectedSha: FILE_SHA,
				}),
			).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		}
	});

	it("拒绝路径穿越且不会发起请求", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		const provider = createProvider(fetchMock);

		await expect(provider.getFile("src/content/posts/../secret.md")).rejects.toThrow(TypeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("拒绝无效乐观锁 SHA 且不会发起更新请求", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		const provider = createProvider(fetchMock);

		await expect(
			provider.updateFile({
				path: repositoryPath,
				content: "updated",
				message: "docs(post): update hello-world",
				expectedSha: "not-a-sha",
			}),
		).rejects.toThrow(TypeError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("拒绝目录响应和无法安全解析的上游响应", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse([{ type: "file", path: repositoryPath }]));

		await expect(createProvider(fetchMock).getFile(repositoryPath)).rejects.toMatchObject({
			status: 502,
			code: "UPSTREAM_ERROR",
		});
	});

	it("网络异常统一失败关闭且不泄露 Token", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockRejectedValue(new Error("Bearer test-token-that-must-not-leak"));

		let thrown: unknown;
		try {
			await createProvider(fetchMock).getFile(repositoryPath);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ApiError);
		expect(thrown).toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
		expect((thrown as Error).message).not.toContain("test-token-that-must-not-leak");
	});

	it("只接受 github.com 的 Commit 地址", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				content: { path: repositoryPath, sha: NEXT_FILE_SHA },
				commit: {
					sha: COMMIT_SHA,
					html_url: `https://attacker.example/commit/${COMMIT_SHA}`,
				},
			}),
		);

		await expect(
			createProvider(fetchMock).createFile({
				path: repositoryPath,
				content: "content",
				message: "feat(post): add hello-world",
			}),
		).rejects.toMatchObject({ status: 502, code: "UPSTREAM_ERROR" });
	});
});
