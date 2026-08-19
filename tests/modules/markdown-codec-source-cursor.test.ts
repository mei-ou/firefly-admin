import { describe, expect, it } from "vitest";
import { createMarkdownSourceCursor } from "../../src/modules/markdown-codec/source-cursor";

describe("Markdown UTF-16 source cursor", () => {
	it("按 UTF-16 offset 读取 astral Unicode 行且不提前推进", () => {
		const source = "😀首行\n末行";
		const cursor = createMarkdownSourceCursor(source);
		const first = cursor.readLine();

		expect(first).toEqual({
			range: { from: 0, to: 5 },
			contentRange: { from: 0, to: 4 },
			newlineRange: { from: 4, to: 5 },
			text: "😀首行",
		});
		expect(cursor.offset).toBe(0);
		expect(cursor.atEnd).toBe(false);

		if (!first) throw new Error("Expected the first source line.");
		cursor.advanceTo(first.range.to);
		expect(cursor.readLine()).toEqual({
			range: { from: 5, to: source.length },
			contentRange: { from: 5, to: source.length },
			newlineRange: null,
			text: "末行",
		});
	});

	it("保留 LF、CRLF、独立 CR 和连续空行的精确范围", () => {
		const source = "a\r\n\n\rb";
		const cursor = createMarkdownSourceCursor(source);
		const lines = [];

		while (!cursor.atEnd) {
			const line = cursor.readLine();
			if (!line) throw new Error("Expected a source line before EOF.");
			lines.push(line);
			cursor.advanceTo(line.range.to);
		}

		expect(lines).toEqual([
			{
				range: { from: 0, to: 3 },
				contentRange: { from: 0, to: 1 },
				newlineRange: { from: 1, to: 3 },
				text: "a",
			},
			{
				range: { from: 3, to: 4 },
				contentRange: { from: 3, to: 3 },
				newlineRange: { from: 3, to: 4 },
				text: "",
			},
			{
				range: { from: 4, to: 5 },
				contentRange: { from: 4, to: 4 },
				newlineRange: { from: 4, to: 5 },
				text: "",
			},
			{
				range: { from: 5, to: 6 },
				contentRange: { from: 5, to: 6 },
				newlineRange: null,
				text: "b",
			},
		]);
		expect(cursor.readLine()).toBeNull();
	});

	it("区分有尾换行与无尾换行，并让空源码直接位于 EOF", () => {
		const withTrailingNewline = createMarkdownSourceCursor("正文\n");
		const line = withTrailingNewline.readLine();
		expect(line?.newlineRange).toEqual({ from: 2, to: 3 });
		if (!line) throw new Error("Expected a trailing-newline source line.");
		withTrailingNewline.advanceTo(line.range.to);
		expect(withTrailingNewline.atEnd).toBe(true);
		expect(withTrailingNewline.readLine()).toBeNull();

		const empty = createMarkdownSourceCursor("");
		expect(empty.offset).toBe(0);
		expect(empty.atEnd).toBe(true);
		expect(empty.readLine()).toBeNull();
	});

	it("允许从合法子范围起点读取，但不把前缀复制或规范化", () => {
		const source = "前缀\r\n正文\n";
		const from = source.indexOf("正文");
		const cursor = createMarkdownSourceCursor(source, from);

		expect(cursor.source).toBe(source);
		expect(cursor.offset).toBe(from);
		expect(cursor.readLine()).toEqual({
			range: { from, to: source.length },
			contentRange: { from, to: source.length - 1 },
			newlineRange: { from: source.length - 1, to: source.length },
			text: "正文",
		});
	});

	it("拒绝非整数、越界、逆向、原地和 CRLF 中间 offset", () => {
		const source = "a\r\nb";
		for (const initialOffset of [0.5, Number.NaN, -1, source.length + 1, 2]) {
			expect(() => createMarkdownSourceCursor(source, initialOffset)).toThrow();
		}

		const cursor = createMarkdownSourceCursor(source);
		expect(() => cursor.advanceTo(0)).toThrow(/strictly forward/);
		cursor.advanceTo(1);
		expect(() => cursor.advanceTo(0)).toThrow(/strictly forward/);
		expect(() => cursor.advanceTo(1)).toThrow(/strictly forward/);
		expect(() => cursor.advanceTo(1.5)).toThrow(/integer/);
		expect(() => cursor.advanceTo(2)).toThrow(/CRLF/);
		expect(() => cursor.advanceTo(source.length + 1)).toThrow(/outside/);
		expect(cursor.offset).toBe(1);
	});
});
