import { describe, expect, it } from "vitest";
import {
	createMarkdownCodecDocument,
	serializeUntouchedMarkdownNodes,
} from "../../src/modules/markdown-codec/document";
import {
	createMarkdownVideoSource,
	recognizeMarkdownVideo,
} from "../../src/modules/markdown-codec/video";
import { FIREFLY_VIDEO_FIXTURES } from "../fixtures/markdown-codec/firefly-video-fixtures";

describe("隔离 Markdown codec Video recognizer", () => {
	it("按真实 video fixtures 分类 disposition/provider，并保留 source slice", () => {
		for (const fixture of FIREFLY_VIDEO_FIXTURES) {
			const result = recognizeMarkdownVideo(fixture.source);
			expect(result.disposition).toBe(fixture.expected.disposition);
			expect(result.provider).toBe(fixture.expected.provider);
			expect(result.node.sourceSlice).toBe(fixture.source);
			if (fixture.expected.disposition === "structured") {
				expect(result.node).toMatchObject({
					category: "source-placeholder",
					kind: "video",
					dirty: false,
					metadata: {
						provider: fixture.expected.provider,
						videoId: fixture.expected.videoId,
					},
				});
				expect(result.diagnostic.code).toBe("recognized-placeholder");
			} else {
				expect(result.node).toMatchObject({ category: "opaque", kind: "opaque", dirty: false });
				expect(result.diagnostic.code).toBe("opaque-fallback");
			}
		}
	});

	it("只接受精确的 YouTube HTTPS 无 query 模板和 11 位 video ID", () => {
		const valid = recognizeMarkdownVideo(
			'<iframe width="100%" height="468" src="https://www.youtube.com/embed/5gIf0_xpFPI" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
		);
		expect(valid.disposition).toBe("structured");
		expect(valid.node).toMatchObject({ metadata: { provider: "youtube", videoId: "5gIf0_xpFPI" } });

		for (const source of [
			'<iframe width="100%" height="468" src="https://www.youtube.com/embed/short" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
			'<iframe width="100%" height="468" src="https://www.youtube.com/embed/5gIf0_xpFPI?si=history" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
		]) {
			const result = recognizeMarkdownVideo(source);
			expect(result.disposition).toBe("opaque");
			expect(result.provider).toBe("youtube");
		}
	});

	it("Bilibili HTTPS 候选保持 blocked，不升级为 structured", () => {
		const source =
			'<iframe width="100%" height="468" src="https://player.bilibili.com/player.html?bvid=BV1fK4y1s7Qf&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>\n';
		const result = recognizeMarkdownVideo(source);
		expect(result.disposition).toBe("blocked");
		expect(result.provider).toBe("bilibili");
		expect(result.node.kind).toBe("opaque");
	});

	it("官方协议相对 Bilibili 模板识别为惰性结构化占位", () => {
		const source = createMarkdownVideoSource("bilibili", "BV1fK4y1s7Qf");
		const result = recognizeMarkdownVideo(source);
		expect(result.disposition).toBe("structured");
		expect(result.provider).toBe("bilibili");
		expect(result.node).toMatchObject({
			kind: "video",
			metadata: { provider: "bilibili", videoId: "BV1fK4y1s7Qf" },
		});
	});

	it("按 Firefly 文档生成 B 站固定源码，并保持画布侧不执行 iframe", () => {
		const source = createMarkdownVideoSource("bilibili", "BV1fK4y1s7Qf");
		expect(source).toBe(
			'<iframe width="100%" height="468" src="//player.bilibili.com/player.html?bvid=BV1fK4y1s7Qf&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>\n',
		);
		const result = recognizeMarkdownVideo(source);
		expect(result.provider).toBe("bilibili");
		expect(result.disposition).toBe("structured");
		expect(result.node.sourceSlice).toBe(source);
	});

	it("视频源码生成器拒绝不完整的 YouTube ID 和 B 站 BV 号", () => {
		expect(() => createMarkdownVideoSource("youtube", "short")).toThrow();
		expect(() => createMarkdownVideoSource("bilibili", "BV1fK4y1s7Q")).toThrow();
	});

	it("危险 iframe 变体统一 opaque 且不创建可执行节点", () => {
		for (const source of [
			'<iframe src="javascript:alert(1)" onload="alert(2)"></iframe>\n',
			'<iframe srcdoc="<script>alert(1)</script>"></iframe>\n',
			'<iframe src="https://user:password@www.youtube.com/embed/5gIf0_xpFPI"></iframe>\n',
			'<iframe width="100%" height="468" src="https://www.youtube.com/embed/5gIf0_xpFPI" src="https://attacker.example/embed/x" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
			'<video controls src="https://media.example.com/example.mp4"></video>\n',
		]) {
			const result = recognizeMarkdownVideo(source);
			expect(result.disposition).toBe("opaque");
			expect(result.node.kind).toBe("opaque");
			expect(result.node.sourceSlice).toBe(source);
		}
	});

	it("CRLF 子范围保留原始 iframe source slice 与 UTF-16 range", () => {
		const source =
			'前缀😀\r\n<iframe width="100%" height="468" src="https://www.youtube.com/embed/5gIf0_xpFPI" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\r\n后缀';
		const from = source.indexOf("<iframe");
		const to = source.indexOf("\r\n后缀");
		const result = recognizeMarkdownVideo(source, { from, to });
		expect(result.disposition).toBe("opaque");
		expect(result.node.sourceSlice).toBe(source.slice(from, to));
	});

	it("structured YouTube video placeholder 可 untouched round-trip", () => {
		const fixture = FIREFLY_VIDEO_FIXTURES[0];
		expect(fixture).toBeDefined();
		if (!fixture) return;
		const result = recognizeMarkdownVideo(fixture.source);
		const document = createMarkdownCodecDocument(fixture.source, [result.node]);
		expect(document.valid).toBe(true);
		expect(serializeUntouchedMarkdownNodes(document.document.nodes)).toBe(fixture.source);
	});
});
