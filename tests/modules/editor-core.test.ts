import { describe, expect, it } from "vitest";
import type { EditorVisualProjection } from "../../src/modules/editor-core/projection";
import { createCodeMirrorAdapter } from "../../src/modules/editor-core/adapters/codemirror-adapter";
import { createVisualEditorAdapter } from "../../src/modules/editor-core/adapters/visual-adapter";
import {
	assertEditorCommandAvailable,
	getEditorCommandDefinition,
} from "../../src/modules/editor-core/capability-registry";
import { createEditorSession } from "../../src/modules/editor-core/session";

function createSurface(initial = "") {
	let value = initial;
	let disabled = false;
	let destroyed = false;
	let projection: EditorVisualProjection | null = null;
	const projectionKinds: string[] = [];
	return {
		surface: {
			getValue: () => value,
			setValue: (next: string) => {
				value = next;
			},
			setDisabled: (next: boolean) => {
				disabled = next;
			},
			destroy: () => {
				destroyed = true;
			},
			setProjection: (next: EditorVisualProjection) => {
				projection = next;
				projectionKinds.push(next.nodes.map((node) => node.category).join(","));
			},
			getProjection: () => {
				if (!projection) throw new TypeError("Projection is not mounted.");
				return projection;
			},
		},
		getValue: () => value,
		isDisabled: () => disabled,
		isDestroyed: () => destroyed,
		projectionKinds,
	};
}

describe("第三阶段 editor-core 契约", () => {
	it("阻断命令没有 adapter 执行路径", () => {
		expect(getEditorCommandDefinition("underline")).toMatchObject({
			status: "blocked",
			adapters: [],
		});
		expect(() => assertEditorCommandAvailable("underline", "visual")).toThrow();
		expect(assertEditorCommandAvailable("bold", "visual").sourceSyntax).toBe("**text**");
	});

	it("CodeMirror adapter 只 flush Markdown 和 revision，并拒绝旧 revision", () => {
		const surface = createSurface();
		const adapter = createCodeMirrorAdapter(surface.surface);
		adapter.mount({ markdown: "原文", revision: 4, disabled: true });
		expect(surface.getValue()).toBe("原文");
		expect(surface.isDisabled()).toBe(true);
		expect(adapter.setMarkdown({ markdown: "旧值", revision: 3 })).toBe(false);
		expect(adapter.setMarkdown({ markdown: "新值", revision: 5 })).toBe(true);
		expect(adapter.flush()).toEqual({ markdown: "新值", revision: 5, diagnostics: [] });
		expect(Object.keys(adapter.flush()).sort()).toEqual(["diagnostics", "markdown", "revision"]);
		adapter.destroy();
		expect(surface.isDestroyed()).toBe(true);
		expect(() => adapter.flush()).toThrow();
		expect(() => adapter.setMarkdown({ markdown: "销毁后", revision: 6 })).toThrow();
	});

	it("visual adapter 复用同一内核无关边界并只暴露 Markdown", () => {
		const surface = createSurface();
		const adapter = createVisualEditorAdapter(surface.surface);
		expect(adapter.mode).toBe("visual");
		const markdown = '画布正文\n\n<iframe src="https://example.com"></iframe>';
		adapter.mount({ markdown, revision: 2 });
		const initialFlush = adapter.flush();
		expect(initialFlush.markdown).toBe(markdown);
		expect(initialFlush.revision).toBe(2);
		expect(initialFlush.diagnostics).toHaveLength(1);
		expect(Object.keys(adapter.flush()).sort()).toEqual(["diagnostics", "markdown", "revision"]);
		expect(surface.projectionKinds).toEqual(["structured,structured,structured,opaque"]);
		expect(adapter.setMarkdown({ markdown: "旧画布值", revision: 1 })).toBe(false);
		expect(surface.projectionKinds).toEqual(["structured,structured,structured,opaque"]);
		const mountedProjection = surface.surface.getProjection();
		const editedProjection: EditorVisualProjection = {
			...mountedProjection,
			nodes: mountedProjection.nodes.map((node, index) =>
				index === 0 && node.category === "structured"
					? { ...node, sourceSlice: "改后的正文" }
					: node,
			),
		};
		surface.surface.setProjection(editedProjection);
		expect(adapter.flush().markdown).toContain("改后的正文");
		expect(adapter.flush().markdown).toContain('<iframe src="https://example.com"></iframe>');
		const protectedEdit: EditorVisualProjection = {
			...surface.surface.getProjection(),
			nodes: surface.surface
				.getProjection()
				.nodes.map((node) =>
					node.category === "opaque" ? { ...node, sourceSlice: "被篡改" } : node,
				),
		};
		surface.surface.setProjection(protectedEdit);
		expect(() => adapter.flush()).toThrow("read-only");
	});

	it("session 只接受当前 revision 的 flush，且不会丢失未知 Front-matter", () => {
		const session = createEditorSession({
			markdown: "正文",
			frontmatter: { title: "标题" },
			unknownFrontmatter: { series: "保留" },
		});
		const revision = session.updateMarkdown("新正文");
		expect(
			session.acceptFlush({ markdown: "旧结果", revision: revision - 1, diagnostics: [] }),
		).toBe(false);
		expect(session.acceptFlush({ markdown: "确认正文", revision, diagnostics: [] })).toBe(true);
		expect(session.acceptDiagnostics(revision, [])).toBe(false);
		expect(session.snapshot()).toMatchObject({
			markdown: "确认正文",
			unknownFrontmatter: { series: "保留" },
			diagnostics: [],
		});
		const currentRevision = session.snapshot().revision;
		expect(
			session.acceptFlush({
				markdown: "不能覆盖",
				revision: currentRevision,
				diagnostics: [
					{
						code: "unsupported-syntax",
						message: "fatal",
						severity: "fatal",
						range: null,
						location: null,
					},
				],
			}),
		).toBe(false);
		expect(session.snapshot().markdown).toBe("确认正文");
	});

	it("完整源码事务在失败时保持原状态，并在成功时保留未知字段", () => {
		const session = createEditorSession({
			frontmatter: { title: "标题", published: new Date("2026-08-12") },
			unknownFrontmatter: { series: "保留" },
			slug: "old-slug",
			markdown: "正文",
		});
		const originalRevision = session.snapshot().revision;
		expect(session.applySource("---\ntitle: [broken")).toBe(false);
		expect(session.snapshot()).toMatchObject({ revision: originalRevision, markdown: "正文" });

		const source = [
			"---",
			"title: 新标题",
			"published: 2026-08-13",
			"series: 新系列",
			"---",
			"新正文",
		].join("\n");
		expect(session.applySource(source)).toBe(true);
		expect(session.snapshot()).toMatchObject({
			frontmatter: { title: "新标题" },
			unknownFrontmatter: { series: "新系列" },
			markdown: "新正文",
		});
		expect(session.snapshot().slug).toBeUndefined();
		expect(session.serializeSource()).toContain("series: 新系列");
	});

	it("fatal diagnostics 不覆盖现有 session 状态", () => {
		const session = createEditorSession({ markdown: "稳定正文" });
		const revision = session.snapshot().revision;
		expect(
			session.acceptFlush({
				markdown: "危险正文",
				revision,
				diagnostics: [
					{
						code: "unsupported-syntax",
						message: "fatal",
						severity: "fatal",
						range: null,
						location: null,
					},
				],
			}),
		).toBe(false);
		expect(session.snapshot().markdown).toBe("稳定正文");
	});
});
