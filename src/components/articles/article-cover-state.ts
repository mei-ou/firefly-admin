import { isArticleAssetImageFilename } from "../../modules/media/media-config";
import { parseArticleRelativeImagePath, parseRemoteImageUrl } from "./markdown-target-validation";

export interface RepositoryCoverCandidate {
	filename: string;
	sha: string;
	reference: string;
}

/**
 * 封面只接受受控 HTTPS 地址或当前 Page Bundle 的图片直接子文件。这里是浏览器侧的
 * 提前反馈；保存时服务端仍会使用同一扩展名和 URL 安全策略重新校验。
 */
export function parseArticleCoverReference(input: unknown): string {
	if (typeof input !== "string") throw new TypeError("封面地址格式无效。");
	const value = input.trim();
	if (value === "") return "";
	if (value.startsWith("./")) {
		const reference = parseArticleRelativeImagePath(value);
		if (!isArticleAssetImageFilename(reference.slice(2))) {
			throw new TypeError("封面必须选择允许的图片文件。");
		}
		return reference;
	}
	return parseRemoteImageUrl(value);
}

/** 详情响应只提供服务端验证过的直接子资源；浏览器再筛掉非图片，避免把附件呈现为封面。 */
export function createRepositoryCoverCandidates(
	resources: readonly { filename: string; blobSha: string }[],
): RepositoryCoverCandidate[] {
	return resources
		.filter((resource) => isArticleAssetImageFilename(resource.filename))
		.map((resource) => ({
			filename: resource.filename,
			sha: resource.blobSha,
			reference: parseArticleRelativeImagePath(`./${resource.filename}`),
		}))
		.sort((left, right) => left.filename.localeCompare(right.filename, "en"));
}

export function replaceArticleCoverReference(
	current: string,
	next: unknown,
): {
	changed: boolean;
	previous: string;
	value: string;
} {
	const previous = current.trim();
	const value = parseArticleCoverReference(next);
	return { changed: previous !== value, previous, value };
}

/** 清除只改变 Frontmatter 引用；仓库文件和草稿资源必须通过各自独立操作显式删除。 */
export function clearArticleCoverReference(current: string): {
	changed: boolean;
	previous: string;
	value: "";
} {
	const previous = current.trim();
	return { changed: previous !== "", previous, value: "" };
}
