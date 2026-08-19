import { getMarkdownSourceLocation } from "./source-range";
import type {
	MarkdownCodecDiagnostic,
	MarkdownCodecDiagnosticCode,
	MarkdownCodecDiagnosticSeverity,
	MarkdownSourceRange,
} from "./types";

export interface CreateMarkdownCodecDiagnosticInput {
	code: MarkdownCodecDiagnosticCode;
	message: string;
	severity: MarkdownCodecDiagnosticSeverity;
	range?: MarkdownSourceRange;
}

/** Diagnostics carry source coordinates only; rendering and localization belong to the UI layer. */
export function createMarkdownCodecDiagnostic(
	source: string,
	input: CreateMarkdownCodecDiagnosticInput,
): MarkdownCodecDiagnostic {
	const range = input.range ?? null;
	return {
		code: input.code,
		message: input.message,
		severity: input.severity,
		range,
		location: range === null ? null : getMarkdownSourceLocation(source, range.from),
	};
}
