import { isMarkdownCrlfInteriorOffset } from "./source-range";
import type { MarkdownSourceRange } from "./types";

/**
 * A physical source line. `range` includes its original newline, while `contentRange` does not.
 * Blank lines deliberately use an empty half-open `contentRange`; they are cursor metadata rather
 * than source-backed codec nodes, so the non-empty node range invariant does not apply here.
 */
export interface MarkdownSourceLine {
	range: MarkdownSourceRange;
	contentRange: MarkdownSourceRange;
	newlineRange: MarkdownSourceRange | null;
	text: string;
}

export interface MarkdownSourceCursor {
	readonly atEnd: boolean;
	readonly offset: number;
	readonly source: string;
	/** Reads the physical line at the current offset without advancing the cursor. */
	readLine(): MarkdownSourceLine | null;
	/** Advances strictly forward to a valid JavaScript UTF-16 offset. */
	advanceTo(nextOffset: number): void;
}

function assertCursorOffset(source: string, offset: number, currentOffset?: number): void {
	if (!Number.isInteger(offset)) {
		throw new TypeError("Markdown source cursor offset must be an integer.");
	}
	if (offset < 0 || offset > source.length) {
		throw new RangeError("Markdown source cursor offset is outside the source.");
	}
	if (isMarkdownCrlfInteriorOffset(source, offset)) {
		throw new RangeError("Markdown source cursor cannot split a CRLF newline.");
	}
	if (currentOffset !== undefined && offset <= currentOffset) {
		throw new RangeError("Markdown source cursor must advance strictly forward.");
	}
}

class ControlledMarkdownSourceCursor implements MarkdownSourceCursor {
	readonly source: string;
	#offset: number;

	constructor(source: string, initialOffset: number) {
		assertCursorOffset(source, initialOffset);
		this.source = source;
		this.#offset = initialOffset;
	}

	get atEnd(): boolean {
		return this.#offset === this.source.length;
	}

	get offset(): number {
		return this.#offset;
	}

	readLine(): MarkdownSourceLine | null {
		if (this.atEnd) return null;

		const from = this.#offset;
		let contentTo = from;
		while (
			contentTo < this.source.length &&
			this.source[contentTo] !== "\r" &&
			this.source[contentTo] !== "\n"
		) {
			contentTo += 1;
		}

		let to = contentTo;
		let newlineRange: MarkdownSourceRange | null = null;
		if (this.source[contentTo] === "\r") {
			to = this.source[contentTo + 1] === "\n" ? contentTo + 2 : contentTo + 1;
			newlineRange = { from: contentTo, to };
		} else if (this.source[contentTo] === "\n") {
			to = contentTo + 1;
			newlineRange = { from: contentTo, to };
		}

		return {
			range: { from, to },
			contentRange: { from, to: contentTo },
			newlineRange,
			text: this.source.slice(from, contentTo),
		};
	}

	advanceTo(nextOffset: number): void {
		assertCursorOffset(this.source, nextOffset, this.#offset);
		this.#offset = nextOffset;
	}
}

/**
 * Creates a controlled cursor over the original string. The cursor never normalizes line endings,
 * converts code-point positions, or copies the complete source into a secondary representation.
 */
export function createMarkdownSourceCursor(
	source: string,
	initialOffset = 0,
): MarkdownSourceCursor {
	return new ControlledMarkdownSourceCursor(source, initialOffset);
}
