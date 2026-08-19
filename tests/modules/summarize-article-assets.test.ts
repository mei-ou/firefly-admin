import { describe, expect, it } from "vitest";
import { summarizeArticleAssets } from "../../src/modules/media/services/summarize-article-assets";
import type { GitDirectoryEntry } from "../../src/providers/git/types";

const pathConfig = {
	contentRoot: "src/content/posts",
	usePageBundle: true,
	entryFilename: "index.md",
};
const storageSlug = "hello-world";

function entry(filename: string, shaCharacter: string, size: number): GitDirectoryEntry {
	return {
		name: filename,
		path: `src/content/posts/${storageSlug}/${filename}`,
		sha: shaCharacter.repeat(40),
		type: "file",
		size,
	};
}

describe("文章资源详情汇总", () => {
	it("按同一文章内容确定封面、正文图片和附件引用", () => {
		const result = summarizeArticleAssets({
			storageSlug,
			frontmatterImage: "./cover.webp",
			markdown: "![插图](./inline.png)\n[下载](./guide.pdf)\n",
			entries: [
				entry("guide.pdf", "a", 3_000),
				entry("cover.webp", "b", 2_000),
				entry("inline.png", "c", 1_000),
			],
			pathConfig,
		});

		expect(result.referenceAnalysis).toEqual({ complete: true, issues: [] });
		expect(result.resources).toMatchObject([
			{
				filename: "cover.webp",
				role: "cover",
				kind: "image",
				policyLevel: "L1",
				riskLevel: "high",
				references: [{ source: "frontmatter-image" }],
			},
			{
				filename: "guide.pdf",
				role: "attachment",
				kind: "document",
				policyLevel: "L1",
				riskLevel: "medium",
				references: [{ source: "markdown-link", line: 2, column: 1 }],
			},
			{
				filename: "inline.png",
				role: "inline",
				kind: "image",
				policyLevel: "L1",
				references: [{ source: "markdown-image", line: 1, column: 1 }],
			},
		]);
	});

	it("未引用的允许类型保持 L0，大小来自目录快照", () => {
		const result = summarizeArticleAssets({
			storageSlug,
			frontmatterImage: "",
			markdown: "正文",
			entries: [entry("guide.pdf", "a", 4_096)],
			pathConfig,
		});
		expect(result.resources[0]).toMatchObject({
			filename: "guide.pdf",
			size: 4_096,
			contentType: "application/pdf",
			role: null,
			policyLevel: "L0",
			riskLevel: "low",
		});
	});

	it("未知扩展名失败关闭为 L2 且不猜测 MIME", () => {
		const result = summarizeArticleAssets({
			storageSlug,
			frontmatterImage: "",
			markdown: "正文",
			entries: [entry("payload.exe", "d", 512)],
			pathConfig,
		});
		expect(result.resources[0]).toMatchObject({
			contentType: null,
			kind: "other-allowed",
			policyLevel: "L2",
			riskLevel: "high",
			mutable: false,
			riskReasons: ["disallowed-resource-type"],
		});
	});

	it("引用语法不完整时所有资源失败关闭且不宣称未引用", () => {
		const result = summarizeArticleAssets({
			storageSlug,
			frontmatterImage: "",
			markdown: "[下载][guide]\n[guide]: ./guide.pdf\n",
			entries: [entry("guide.pdf", "e", 1_024)],
			pathConfig,
		});
		expect(result.referenceAnalysis.complete).toBe(false);
		expect(result.resources[0]).toMatchObject({
			policyLevel: "L2",
			mutable: false,
			riskReasons: ["incomplete-reference-analysis"],
			references: [],
		});
	});

	it("拒绝目录和越过服务端重建路径的条目", () => {
		const base = {
			storageSlug,
			frontmatterImage: "",
			markdown: "正文",
			pathConfig,
		};
		expect(() =>
			summarizeArticleAssets({
				...base,
				entries: [{ ...entry("guide.pdf", "f", 1), type: "directory", size: null }],
			}),
		).toThrow("子目录");
		expect(() =>
			summarizeArticleAssets({
				...base,
				entries: [{ ...entry("guide.pdf", "f", 1), path: "README.md" }],
			}),
		).toThrow("无效文章资源路径");
	});
});
