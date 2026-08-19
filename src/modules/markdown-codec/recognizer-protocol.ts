import { validateMarkdownSourceRange } from "./source-range";
import type { MarkdownCodecDiagnostic, MarkdownCodecNode, MarkdownSourceRange } from "./types";

export type MarkdownRecognizerDisposition = "recognized" | "opaque";

/**
 * A candidate is the source region selected by the scanner before a recognizer interprets it. The
 * recognizer may return a smaller node range (inline math is the audited example), but it may never
 * escape the candidate or silently consume the surrounding text.
 */
export interface MarkdownRecognizerCandidate {
	candidateRange: MarkdownSourceRange;
}

export interface MarkdownRecognizerSuccess extends MarkdownRecognizerCandidate {
	disposition: "recognized";
	node: MarkdownCodecNode;
	diagnostic: MarkdownCodecDiagnostic;
}

export interface MarkdownRecognizerOpaque extends MarkdownRecognizerCandidate {
	disposition: "opaque";
	node: MarkdownCodecNode;
	diagnostic: MarkdownCodecDiagnostic;
}

export type MarkdownRecognizerResult = MarkdownRecognizerOpaque | MarkdownRecognizerSuccess;

export interface MarkdownRecognizerRangeValidation {
	valid: boolean;
	reason:
		| "candidate-invalid"
		| "node-invalid"
		| "node-outside-candidate"
		| "node-slice-mismatch"
		| null;
}

/**
 * Validates the composition boundary without normalizing or sorting ranges. Candidate and adopted
 * node boundaries use the same UTF-16 and CRLF contract as the final document validator.
 */
export function validateMarkdownRecognizerResult(
	source: string,
	result: MarkdownRecognizerResult,
): MarkdownRecognizerRangeValidation {
	if (!validateMarkdownSourceRange(source, result.candidateRange).valid) {
		return { valid: false, reason: "candidate-invalid" };
	}
	if (!validateMarkdownSourceRange(source, result.node.range).valid) {
		return { valid: false, reason: "node-invalid" };
	}
	if (
		result.node.range.from < result.candidateRange.from ||
		result.node.range.to > result.candidateRange.to
	) {
		return { valid: false, reason: "node-outside-candidate" };
	}
	if (source.slice(result.node.range.from, result.node.range.to) !== result.node.sourceSlice) {
		return { valid: false, reason: "node-slice-mismatch" };
	}
	return { valid: true, reason: null };
}

export function isMarkdownRecognizerResultRecognized(
	result: MarkdownRecognizerResult,
): result is MarkdownRecognizerSuccess {
	return result.disposition === "recognized";
}
