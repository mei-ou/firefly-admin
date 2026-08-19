import { describe, expect, it } from "vitest";
import {
	isMarkdownRecognizerResultRecognized,
	validateMarkdownRecognizerResult,
} from "../../src/modules/markdown-codec/recognizer-protocol";
import type { MarkdownRecognizerResult } from "../../src/modules/markdown-codec/recognizer-protocol";

function createResult(
	source: string,
	candidateRange: { from: number; to: number },
	nodeRange = candidateRange,
	disposition: "recognized" | "opaque" = "recognized",
): MarkdownRecognizerResult {
	const node =
		disposition === "recognized"
			? {
					category: "structured" as const,
					kind: "text" as const,
					dirty: false as const,
					range: nodeRange,
					sourceSlice: source.slice(nodeRange.from, nodeRange.to),
				}
			: {
					category: "opaque" as const,
					kind: "opaque" as const,
					dirty: false as const,
					range: nodeRange,
					sourceSlice: source.slice(nodeRange.from, nodeRange.to),
					reason: "test opaque",
				};
	return {
		candidateRange,
		disposition,
		node,
		diagnostic: {
			code: disposition === "recognized" ? "recognized-placeholder" : "opaque-fallback",
			message: "test",
			severity: "info",
			range: nodeRange,
			location: null,
		},
	};
}

describe("Markdown recognizer composition protocol", () => {
	it("允许 node.range 小于 candidateRange，例如 inline Math probe", () => {
		const source = "前缀 $x$ 后缀";
		const result = createResult(source, { from: 0, to: source.length }, { from: 3, to: 6 });
		expect(validateMarkdownRecognizerResult(source, result)).toEqual({ valid: true, reason: null });
		expect(isMarkdownRecognizerResultRecognized(result)).toBe(true);
	});

	it("允许 opaque 结果保留 candidateRange 和诊断", () => {
		const source = "<script>alert(1)</script>";
		const result = createResult(source, { from: 0, to: source.length }, undefined, "opaque");
		expect(validateMarkdownRecognizerResult(source, result)).toEqual({ valid: true, reason: null });
		expect(isMarkdownRecognizerResultRecognized(result)).toBe(false);
	});

	it("拒绝 candidate 越界、node 越界 candidate、CRLF 内部边界与 source slice 不匹配", () => {
		const source = "abcdef";
		expect(
			validateMarkdownRecognizerResult(source, createResult(source, { from: -1, to: 2 })),
		).toEqual({ valid: false, reason: "candidate-invalid" });
		expect(
			validateMarkdownRecognizerResult(
				source,
				createResult(source, { from: 1, to: 3 }, { from: 0, to: 3 }),
			),
		).toEqual({ valid: false, reason: "node-outside-candidate" });

		const crlfSource = "a\r\nb";
		expect(
			validateMarkdownRecognizerResult(
				crlfSource,
				createResult(crlfSource, { from: 0, to: 2 }, { from: 0, to: 1 }),
			),
		).toEqual({ valid: false, reason: "candidate-invalid" });

		const mismatch = createResult(source, { from: 0, to: 3 });
		mismatch.node.sourceSlice = "wrong";
		expect(validateMarkdownRecognizerResult(source, mismatch)).toEqual({
			valid: false,
			reason: "node-slice-mismatch",
		});
	});

	it("拒绝空范围、逆序范围和 node 越界", () => {
		const source = "abcdef";
		for (const result of [
			createResult(source, { from: 1, to: 1 }),
			createResult(source, { from: 4, to: 2 }),
			createResult(source, { from: 0, to: source.length }, { from: 0, to: source.length + 1 }),
		]) {
			expect(validateMarkdownRecognizerResult(source, result).valid).toBe(false);
		}
	});
});
