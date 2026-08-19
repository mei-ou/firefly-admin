import { parseUncredentialedHttpsUrl } from "../../core/security/url-policy";

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
	});
}
const SAFE_MAILTO_PATTERN = /^mailto:[^\s@]+@[^\s@]+$/iu;
const SAFE_RELATIVE_IMAGE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function assertCommonTargetSafety(value: string): string {
	const target = value.trim();
	if (
		target.length === 0 ||
		target.length > 2_048 ||
		target !== target.normalize("NFKC") ||
		containsControlCharacter(target) ||
		target.includes("\\")
	) {
		throw new TypeError("链接目标格式无效。");
	}
	return target;
}

/**
 * 图床地址不会由 Worker 代抓取，避免 SSRF；这里仍拒绝危险协议和凭据 URL，确保写入
 * Markdown 后不会为正式站点制造 javascript/data/file 等可执行目标。
 */
export function parseRemoteImageUrl(input: unknown): string {
	if (typeof input !== "string") throw new TypeError("图片地址格式无效。");
	return parseUncredentialedHttpsUrl(assertCommonTargetSafety(input), "图片地址");
}

export function parseExternalLinkTarget(input: unknown): string {
	if (typeof input !== "string") throw new TypeError("链接地址格式无效。");
	const target = assertCommonTargetSafety(input);
	if (SAFE_MAILTO_PATTERN.test(target)) return target;
	return parseUncredentialedHttpsUrl(target, "外部链接");
}

export function parseInternalLinkTarget(input: unknown): string {
	if (typeof input !== "string") throw new TypeError("站内链接格式无效。");
	const target = assertCommonTargetSafety(input);
	if (!target.startsWith("/") || target.startsWith("//")) {
		throw new TypeError("站内链接必须使用以单个斜杠开头的路径。");
	}
	const url = new URL(target, "https://firefly.invalid");
	if (
		url.origin !== "https://firefly.invalid" ||
		url.search ||
		!url.pathname.startsWith("/posts/") ||
		!url.pathname.endsWith("/")
	) {
		throw new TypeError("站内文章链接必须使用 /posts/<entry-id>/ 路径且不能包含查询参数。");
	}
	return `${url.pathname}${url.hash}`;
}

export function parseHeadingLinkTarget(input: unknown): string {
	if (typeof input !== "string") throw new TypeError("段落链接格式无效。");
	const target = assertCommonTargetSafety(input);
	if (!target.startsWith("#") || target.length === 1 || target.includes(" ")) {
		throw new TypeError("段落链接必须是有效的标题锚点。");
	}
	return target;
}

/**
 * Page Bundle 内图片只允许当前目录的直接子文件。仓库选择器接入后会由服务端生成该值，
 * 浏览器校验仅用于尽早提示，不能替代服务端路径策略。
 */
export function parseArticleRelativeImagePath(input: unknown): string {
	if (typeof input !== "string") throw new TypeError("图片路径格式无效。");
	const target = assertCommonTargetSafety(input);
	if (!target.startsWith("./") || (target.includes("/") && target.slice(2).includes("/"))) {
		throw new TypeError("文章图片必须位于当前文章目录。");
	}
	const filename = target.slice(2);
	if (
		filename === "." ||
		filename === ".." ||
		filename.includes("%") ||
		!SAFE_RELATIVE_IMAGE_SEGMENT.test(filename)
	) {
		throw new TypeError("图片路径格式无效。");
	}
	return `./${filename}`;
}
