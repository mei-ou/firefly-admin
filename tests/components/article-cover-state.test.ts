import { describe, expect, it } from "vitest";
import {
	clearArticleCoverReference,
	createRepositoryCoverCandidates,
	parseArticleCoverReference,
	replaceArticleCoverReference,
} from "../../src/components/articles/article-cover-state";

describe("文章封面浏览器状态", () => {
	it("接受受控 HTTPS 与当前 Page Bundle 图片引用", () => {
		expect(parseArticleCoverReference(" https://images.example.com/cover.webp ")).toBe(
			"https://images.example.com/cover.webp",
		);
		expect(parseArticleCoverReference("./cover.webp")).toBe("./cover.webp");
		expect(parseArticleCoverReference("")).toBe("");
	});

	it("拒绝 HTTP、凭据、查询参数、异常端口、协议相对 URL 和非图片本地资源", () => {
		for (const value of [
			"http://images.example.com/cover.webp",
			"https://user:pass@images.example.com/cover.webp",
			"https://images.example.com/cover.webp?token=secret",
			"https://images.example.com:8443/cover.webp",
			"//images.example.com/cover.webp",
			"./guide.pdf",
			"./archive.zip",
		]) {
			expect(() => parseArticleCoverReference(value), value).toThrow();
		}
	});

	it("只从服务端资源快照生成图片候选并保持稳定排序", () => {
		expect(
			createRepositoryCoverCandidates([
				{ filename: "z-last.png", blobSha: "b".repeat(40) },
				{ filename: "guide.pdf", blobSha: "c".repeat(40) },
				{ filename: "Cover.JPEG", blobSha: "a".repeat(40) },
				{ filename: "archive.zip", blobSha: "d".repeat(40) },
			]),
		).toEqual([
			{ filename: "Cover.JPEG", sha: "a".repeat(40), reference: "./Cover.JPEG" },
			{ filename: "z-last.png", sha: "b".repeat(40), reference: "./z-last.png" },
		]);
	});

	it("替换封面只返回 Frontmatter 变化，不表达删除文件", () => {
		expect(replaceArticleCoverReference("./old.webp", "./next.png")).toEqual({
			changed: true,
			previous: "./old.webp",
			value: "./next.png",
		});
		expect(replaceArticleCoverReference("./next.png", "./next.png").changed).toBe(false);
	});

	it("清除封面仅移除引用，保留原值用于 UI 明确提示", () => {
		expect(clearArticleCoverReference(" ./cover.webp ")).toEqual({
			changed: true,
			previous: "./cover.webp",
			value: "",
		});
		expect(clearArticleCoverReference("").changed).toBe(false);
	});
});
