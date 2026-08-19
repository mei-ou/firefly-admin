import { describe, expect, it, vi } from "vitest";
import { commitStagedMedia } from "../../src/modules/media/services/commit-staged-media";
import type { R2ObjectBodyBinding } from "../../src/types/env";

const id = "123e4567-e89b-12d3-a456-426614174000";
const objectKey = `staging/2026/08/${id}.png`;
const commitSha = "a".repeat(40);
const fileSha = "b".repeat(40);
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pathConfig = {
	contentRoot: "src/content/posts",
	usePageBundle: true,
	entryFilename: "index.md",
};

function createObject(overrides: Partial<R2ObjectBodyBinding> = {}): R2ObjectBodyBinding {
	return {
		key: objectKey,
		size: pngBytes.byteLength,
		etag: "etag-1",
		uploaded: new Date("2026-08-13T13:00:00.000Z"),
		httpMetadata: { contentType: "image/png" },
		customMetadata: {
			originalFilename: "My Cover (最终).png",
			uploaderSubject: "subject-1",
		},
		arrayBuffer: async () => pngBytes.slice().buffer,
		...overrides,
	};
}

function createDependencies(object: R2ObjectBodyBinding | null = createObject()) {
	const get = vi.fn().mockResolvedValue(object);
	const getFile = vi.fn().mockResolvedValue({
		path: "src/content/posts/hello-world/index.md",
		sha: "c".repeat(40),
		content: "# Existing article",
		encoding: "utf-8" as const,
	});
	const createBinaryFile = vi.fn().mockImplementation(async ({ path }) => ({
		commitSha,
		commitUrl: `https://github.com/firefly-owner/firefly-blog/commit/${commitSha}`,
		fileSha,
		filePath: path,
	}));
	return {
		dependencies: { bucket: { get }, gitProvider: { getFile, createBinaryFile }, pathConfig },
		get,
		getFile,
		createBinaryFile,
	};
}

const input = {
	storageSlug: "hello-world",
	objectKey,
	etag: "etag-1",
	subject: "subject-1",
};

describe("R2 暂存图片转存服务", () => {
	it("只在文章 Page Bundle 中创建服务端命名的二进制图片", async () => {
		const { dependencies, get, createBinaryFile } = createDependencies();
		const result = await commitStagedMedia(input, dependencies);

		expect(dependencies.gitProvider.getFile).toHaveBeenCalledWith(
			"src/content/posts/hello-world/index.md",
		);
		expect(get).toHaveBeenCalledWith(objectKey);
		expect(createBinaryFile).toHaveBeenCalledWith({
			path: "src/content/posts/hello-world/my-cover-123e4567e89b.png",
			content: pngBytes,
			message: "assets(post): add hello-world/my-cover-123e4567e89b.png",
		});
		expect(result).toEqual({
			storageSlug: "hello-world",
			repositoryPath: "src/content/posts/hello-world/my-cover-123e4567e89b.png",
			relativePath: "./my-cover-123e4567e89b.png",
			commitSha,
			commitUrl: `https://github.com/firefly-owner/firefly-blog/commit/${commitSha}`,
			fileSha,
		});
	});

	it("文章入口不存在时不会读取 R2 或创建孤儿图片", async () => {
		const { dependencies, get, getFile, createBinaryFile } = createDependencies();
		getFile.mockRejectedValue({ status: 404, code: "NOT_FOUND" });
		await expect(commitStagedMedia(input, dependencies)).rejects.toMatchObject({ status: 404 });
		expect(get).not.toHaveBeenCalled();
		expect(createBinaryFile).not.toHaveBeenCalled();
	});

	it("在 GitHub 写入前拒绝路径、版本、所有权、格式和大小异常", async () => {
		const cases: Array<{
			input?: typeof input;
			object: R2ObjectBodyBinding | null;
			status: number;
		}> = [
			{ input: { ...input, objectKey: "../secret.png" }, object: createObject(), status: 400 },
			{ input: { ...input, etag: "old-etag" }, object: createObject(), status: 409 },
			{ object: createObject({ customMetadata: { uploaderSubject: "subject-2" } }), status: 404 },
			{ object: createObject({ size: 1024 * 1024 + 1 }), status: 413 },
			{ object: createObject({ httpMetadata: { contentType: "image/jpeg" } }), status: 415 },
			{
				object: createObject({
					arrayBuffer: async () => new TextEncoder().encode("fakepng").buffer,
				}),
				status: 415,
			},
		];

		for (const item of cases) {
			const { dependencies, createBinaryFile } = createDependencies(item.object);
			await expect(commitStagedMedia(item.input ?? input, dependencies)).rejects.toMatchObject({
				status: item.status,
			});
			expect(createBinaryFile).not.toHaveBeenCalled();
		}
	});

	it("R2 读取失败时失败关闭且不触发 GitHub", async () => {
		const { dependencies, get, createBinaryFile } = createDependencies();
		get.mockRejectedValue(new Error("bucket detail"));
		await expect(commitStagedMedia(input, dependencies)).rejects.toMatchObject({
			status: 503,
			code: "UPSTREAM_UNAVAILABLE",
		});
		expect(createBinaryFile).not.toHaveBeenCalled();
	});
});
