import { createMarkdownCodecDiagnostic } from "./diagnostics";
import { createMarkdownOpaqueFallback } from "./opaque-fallback";
import { readMarkdownSourceSlice, validateMarkdownSourceRange } from "./source-range";
import type {
	MarkdownCodecDiagnostic,
	MarkdownSourcePlaceholderNode,
	MarkdownSourceRange,
} from "./types";

export type MarkdownVideoDisposition = "blocked" | "opaque" | "structured";
export type MarkdownVideoProvider = "bilibili" | "unknown" | "youtube";

export function createMarkdownVideoSource(
	provider: Exclude<MarkdownVideoProvider, "unknown">,
	videoId: string,
): string {
	if (provider === "youtube") {
		if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
			throw new Error("YouTube video ID must use the 11-character form.");
		}
		return `<iframe width="100%" height="468" src="https://www.youtube.com/embed/${videoId}" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n`;
	}

	if (!/^BV[A-Za-z0-9]{10}$/.test(videoId)) {
		throw new Error("Bilibili video ID must use the BV plus 10-character form.");
	}
	return `<iframe width="100%" height="468" src="//player.bilibili.com/player.html?bvid=${videoId}&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>\n`;
}

export interface MarkdownVideoNode extends MarkdownSourcePlaceholderNode {
	kind: "video";
	metadata: Readonly<{
		provider: "bilibili" | "youtube";
		videoId: string;
	}>;
}

export interface MarkdownVideoRecognition {
	node: MarkdownVideoNode | ReturnType<typeof createMarkdownOpaqueFallback>["node"];
	diagnostic: MarkdownCodecDiagnostic;
	disposition: MarkdownVideoDisposition;
	provider: MarkdownVideoProvider;
}

const YOUTUBE_TEMPLATE =
	/^<iframe width="100%" height="468" src="https:\/\/www\.youtube\.com\/embed\/([A-Za-z0-9_-]{11})" title="YouTube video player" frameborder="0" allowfullscreen><\/iframe>\n$/;
const YOUTUBE_SOURCE_HINT = /src="(?:https?:)?\/\/www\.youtube\.com\/embed\/([A-Za-z0-9_-]{11})/;
const BILIBILI_TEMPLATE =
	/^<iframe width="100%" height="468" src="\/\/player\.bilibili\.com\/player\.html\?bvid=(BV[A-Za-z0-9]{10})&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"><\/iframe>\n$/;
const BILIBILI_HTTPS_SOURCE =
	/^<iframe width="100%" height="468" src="https:\/\/player\.bilibili\.com\/player\.html\?bvid=([A-Za-z0-9]+)&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"><\/iframe>\n$/;

function createOpaqueResult(
	source: string,
	range: MarkdownSourceRange,
	reason: string,
	provider: MarkdownVideoProvider,
	disposition: MarkdownVideoDisposition = "opaque",
): MarkdownVideoRecognition {
	const fallback = createMarkdownOpaqueFallback(source, range, reason);
	return {
		node: fallback.node,
		diagnostic: fallback.diagnostic,
		disposition,
		provider,
	};
}

/**
 * Classify the audited video source forms without parsing HTML into a DOM. Structured nodes are
 * inert placeholders; no source is mounted as an iframe or normalized outside its fixed template.
 */
export function recognizeMarkdownVideo(
	source: string,
	range: MarkdownSourceRange = { from: 0, to: source.length },
): MarkdownVideoRecognition {
	const validation = validateMarkdownSourceRange(source, range);
	if (!validation.valid) {
		throw new TypeError(`Invalid Markdown Video source range: ${validation.reason}.`);
	}

	const sourceSlice = readMarkdownSourceSlice(source, range);
	const youtubeMatch = YOUTUBE_TEMPLATE.exec(sourceSlice);
	if (youtubeMatch) {
		const videoId = youtubeMatch[1];
		if (!videoId) {
			return createOpaqueResult(
				source,
				range,
				"YouTube video ID is missing from the exact template.",
				"youtube",
			);
		}
		const node: MarkdownVideoNode = {
			category: "source-placeholder",
			kind: "video",
			dirty: false,
			range,
			sourceSlice,
			metadata: { provider: "youtube", videoId },
		};
		return {
			node,
			diagnostic: createMarkdownCodecDiagnostic(source, {
				code: "recognized-placeholder",
				message:
					"Exact YouTube video template recognized as an inert placeholder; no iframe is created.",
				severity: "info",
				range,
			}),
			disposition: "structured",
			provider: "youtube",
		};
	}

	const bilibiliMatch = BILIBILI_TEMPLATE.exec(sourceSlice);
	if (bilibiliMatch) {
		const videoId = bilibiliMatch[1];
		if (!videoId) {
			return createOpaqueResult(
				source,
				range,
				"Bilibili video ID is missing from the exact template.",
				"bilibili",
			);
		}
		const node: MarkdownVideoNode = {
			category: "source-placeholder",
			kind: "video",
			dirty: false,
			range,
			sourceSlice,
			metadata: { provider: "bilibili", videoId },
		};
		return {
			node,
			diagnostic: createMarkdownCodecDiagnostic(source, {
				code: "recognized-placeholder",
				message:
					"Exact Firefly Bilibili video template recognized as an inert placeholder; no iframe is created.",
				severity: "info",
				range,
			}),
			disposition: "structured",
			provider: "bilibili",
		};
	}

	if (BILIBILI_HTTPS_SOURCE.test(sourceSlice)) {
		return createOpaqueResult(
			source,
			range,
			"Bilibili video remains blocked because deployed remote-player equivalence is unverified.",
			"bilibili",
			"blocked",
		);
	}

	const provider: MarkdownVideoProvider = sourceSlice.includes("youtube.com")
		? "youtube"
		: sourceSlice.includes("bilibili.com")
			? "bilibili"
			: "unknown";
	const hint = provider === "youtube" ? YOUTUBE_SOURCE_HINT.exec(sourceSlice) : null;
	const reason = hint
		? "YouTube source is outside the exact fixed template; query and attribute variations remain opaque."
		: provider === "bilibili"
			? "Bilibili source is outside the blocked HTTPS candidate or uses unverified raw iframe syntax."
			: "Unknown or unsafe video iframe remains opaque; Admin does not create or execute iframes.";
	return createOpaqueResult(source, range, reason, provider);
}
