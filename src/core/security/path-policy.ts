import { articleConfig } from "../../config/articleConfig";
import { parseSlug } from "../../utils/slug-utils";

const SAFE_DIRECTORY_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SAFE_MARKDOWN_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/;
const SAFE_RESOURCE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.[a-zA-Z0-9]+$/;
const WINDOWS_RESERVED_FILENAME_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_RESOURCE_FILENAME_LENGTH = 120;

export interface ArticlePathConfig {
	contentRoot: string;
	usePageBundle: boolean;
	entryFilename: string;
}

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
	});
}

/**
 * 验证服务端路径配置。配置虽然不来自浏览器，但错误的部署变量或未来重构仍可能
 * 把写入范围移出文章目录，因此同样采用失败关闭策略。
 */
function parseContentRoot(input: string): string {
	if (
		input.length === 0 ||
		input.length > 512 ||
		input !== input.normalize("NFKC") ||
		input.startsWith("/") ||
		input.endsWith("/") ||
		input.includes("\\") ||
		input.includes("%") ||
		input.includes(":") ||
		containsControlCharacter(input)
	) {
		throw new TypeError("文章内容根目录配置无效。");
	}

	const segments = input.split("/");
	if (
		segments.length === 0 ||
		segments.some(
			(segment) => segment === "." || segment === ".." || !SAFE_DIRECTORY_SEGMENT.test(segment),
		)
	) {
		throw new TypeError("文章内容根目录配置无效。");
	}

	return segments.join("/");
}

function parseEntryFilename(input: string): string {
	if (
		input.length > 100 ||
		input !== input.normalize("NFKC") ||
		containsControlCharacter(input) ||
		!SAFE_MARKDOWN_FILENAME.test(input)
	) {
		throw new TypeError("文章入口文件配置无效。");
	}
	return input;
}

/**
 * 验证 Page Bundle 的直接子资源文件名。禁止路径分隔符、编码分隔符和 Unicode
 * 兼容折叠，确保同一规则可用于 Frontmatter、暂存清单和最终 Git Tree。
 */
export function parseArticleResourceFilename(input: unknown): string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input.length > MAX_RESOURCE_FILENAME_LENGTH ||
		input !== input.normalize("NFKC") ||
		input.includes("%") ||
		input.includes(":") ||
		containsControlCharacter(input) ||
		!SAFE_RESOURCE_FILENAME.test(input)
	) {
		throw new TypeError("文章资源文件名无效。");
	}
	const filenameStem = input.slice(0, input.lastIndexOf("."));
	if (WINDOWS_RESERVED_FILENAME_STEM.test(filenameStem)) {
		throw new TypeError("文章资源文件名无效。");
	}
	return input;
}

/**
 * Git 路径大小写敏感，但后台需要同时兼容 Windows 工作区。冲突键统一按 NFKC 后小写，
 * 确保 `Cover.PNG` 与 `cover.png` 不会在不同环境中形成不一致或隐式覆盖。
 */
export function getArticleResourceFilenameConflictKey(input: unknown): string {
	return parseArticleResourceFilename(input).normalize("NFKC").toLowerCase();
}

/** 本地资源引用固定为 `./<safeFilename>`，不允许子目录或跨 Page Bundle 引用。 */
export function parseArticleResourceReference(input: unknown): string {
	if (typeof input !== "string" || !input.startsWith("./")) {
		throw new TypeError("文章资源引用无效。");
	}
	const filename = parseArticleResourceFilename(input.slice(2));
	if (
		getArticleResourceFilenameConflictKey(filename) ===
		parseEntryFilename(articleConfig.entryFilename).normalize("NFKC").toLowerCase()
	) {
		throw new TypeError("文章资源不能覆盖入口文件。");
	}
	return `./${filename}`;
}

export interface ControlledArticleResourceReference {
	reference: string;
	storageSlug: string;
	filename: string;
	repositoryPath: string;
}

/**
 * 为媒体事务构造唯一允许的 Page Bundle 资源引用。普通文章写入仍只能使用上面的 `./` parser；
 * 单层 `../<slug>/` 只在服务端已经同时验证源、目标文章身份时使用，不能成为任意路径入口。
 */
export function buildControlledArticleResourceReference(
	fromStorageSlugInput: unknown,
	targetStorageSlugInput: unknown,
	filenameInput: unknown,
	config: ArticlePathConfig = articleConfig,
): string {
	const fromStorageSlug = parseSlug(fromStorageSlugInput);
	const targetStorageSlug = parseSlug(targetStorageSlugInput);
	const filename = parseArticleResourceFilename(filenameInput);
	buildArticleResourcePath(targetStorageSlug, filename, config);
	return fromStorageSlug === targetStorageSlug
		? parseArticleResourceReference(`./${filename}`)
		: `../${targetStorageSlug}/${filename}`;
}

/**
 * 解析受控媒体事务引用。只接受规范的当前 Bundle `./file` 或同级 Bundle `../slug/file`；
 * 不接受 query、fragment、百分号编码、反斜杠、更多层级或指向当前 Bundle 的非规范 `../`。
 */
export function parseControlledArticleResourceReference(
	fromStorageSlugInput: unknown,
	referenceInput: unknown,
	config: ArticlePathConfig = articleConfig,
): ControlledArticleResourceReference {
	const fromStorageSlug = parseSlug(fromStorageSlugInput);
	if (typeof referenceInput !== "string") {
		throw new TypeError("文章资源引用无效。");
	}
	if (referenceInput.startsWith("./")) {
		const reference = parseArticleResourceReference(referenceInput);
		const filename = reference.slice(2);
		return {
			reference,
			storageSlug: fromStorageSlug,
			filename,
			repositoryPath: buildArticleResourcePath(fromStorageSlug, filename, config),
		};
	}
	if (!referenceInput.startsWith("../")) {
		throw new TypeError("文章资源引用无效。");
	}
	const segments = referenceInput.slice(3).split("/");
	if (segments.length !== 2) throw new TypeError("文章资源引用无效。");
	const storageSlug = parseSlug(segments[0]);
	const filename = parseArticleResourceFilename(segments[1]);
	if (storageSlug === fromStorageSlug) {
		throw new TypeError("当前文章资源必须使用规范的相对引用。");
	}
	const reference = buildControlledArticleResourceReference(
		fromStorageSlug,
		storageSlug,
		filename,
		config,
	);
	if (reference !== referenceInput) throw new TypeError("文章资源引用无效。");
	return {
		reference,
		storageSlug,
		filename,
		repositoryPath: buildArticleResourcePath(storageSlug, filename, config),
	};
}

/**
 * 根据已验证 slug 构造唯一允许的 GitHub 仓库相对路径。
 *
 * 调用方不能传完整路径、分支或扩展名；P1 固定 Page Bundle 与 Markdown，从接口
 * 形态上消除“校验了 slug，却在别处误用客户端路径”的可能性。
 */
export function buildArticlePath(
	slugInput: unknown,
	config: ArticlePathConfig = articleConfig,
): string {
	if (!config.usePageBundle) {
		throw new TypeError("P1 仅支持 Page Bundle 文章路径。");
	}

	const contentRoot = parseContentRoot(config.contentRoot);
	const slug = parseSlug(slugInput);
	const entryFilename = parseEntryFilename(config.entryFilename);
	const path = `${contentRoot}/${slug}/${entryFilename}`;

	// 组件已逐项验证；最终前缀检查仍作为纵深防御，防止未来修改时破坏目录边界。
	if (!path.startsWith(`${contentRoot}/`) || path === contentRoot) {
		throw new TypeError("文章路径超出允许的内容目录。");
	}

	return path;
}

/** 根据文章 slug 与安全文件名构造当前 Page Bundle 的唯一资源仓库路径。 */
export function buildArticleResourcePath(
	slugInput: unknown,
	filenameInput: unknown,
	config: ArticlePathConfig = articleConfig,
): string {
	if (!config.usePageBundle) {
		throw new TypeError("P1 仅支持 Page Bundle 文章路径。");
	}

	const contentRoot = parseContentRoot(config.contentRoot);
	const slug = parseSlug(slugInput);
	const entryFilename = parseEntryFilename(config.entryFilename);
	const filename = parseArticleResourceFilename(filenameInput);
	if (
		getArticleResourceFilenameConflictKey(filename) ===
		entryFilename.normalize("NFKC").toLowerCase()
	) {
		throw new TypeError("文章资源不能覆盖入口文件。");
	}

	const bundleRoot = `${contentRoot}/${slug}`;
	const path = `${bundleRoot}/${filename}`;
	if (!path.startsWith(`${bundleRoot}/`) || path === bundleRoot) {
		throw new TypeError("文章资源路径超出允许的文章目录。");
	}
	return path;
}
