import { pinyin } from "pinyin-pro";

export const SLUG_MAX_LENGTH = 100;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function containsUnsafeSlugCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		if (character === "/" || character === "\\" || character === "%") {
			return true;
		}
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
	});
}

export type SlugValidationResult =
	| { valid: true; slug: string }
	| { valid: false; reason: "empty" | "too-long" | "unsafe-input" | "invalid-format" };

/**
 * 将标题转换为与 Firefly 新文章脚本一致的 URL slug。
 *
 * 中文使用无声调拼音，`ü` 转为 `v`；拉丁字符统一小写。标点和空白只作为
 * 分隔符处理，最终结果仍必须通过严格 slug 校验，转换函数本身不是安全边界。
 */
export function createSlugFromTitle(title: string): string {
	const transliterated = pinyin(title.normalize("NFKC"), {
		toneType: "none",
		type: "array",
		nonZh: "consecutive",
		v: true,
	}).join(" ");

	return transliterated
		.toLowerCase()
		.replaceAll("'", "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
}

/**
 * 校验用户手动编辑的 slug。校验前只执行 NFKC 以识别全角混淆，不自动修复；
 * 这可避免浏览器显示值与服务端实际写入路径不一致。
 */
export function validateSlug(input: unknown): SlugValidationResult {
	if (typeof input !== "string") {
		return { valid: false, reason: "invalid-format" };
	}

	const normalized = input.normalize("NFKC");
	if (normalized.length === 0) {
		return { valid: false, reason: "empty" };
	}
	if (normalized.length > SLUG_MAX_LENGTH) {
		return { valid: false, reason: "too-long" };
	}
	if (containsUnsafeSlugCharacter(normalized) || normalized.includes("..")) {
		return { valid: false, reason: "unsafe-input" };
	}
	if (normalized !== input || !SLUG_PATTERN.test(normalized)) {
		return { valid: false, reason: "invalid-format" };
	}

	return { valid: true, slug: normalized };
}

/** 验证 slug 并在无效时抛出不包含原始恶意输入的稳定错误。 */
export function parseSlug(input: unknown): string {
	const result = validateSlug(input);
	if (!result.valid) {
		throw new TypeError(`Slug 校验失败：${result.reason}`);
	}
	return result.slug;
}
