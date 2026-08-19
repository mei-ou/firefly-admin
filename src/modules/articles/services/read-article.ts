import { articleConfig } from "../../../config/articleConfig";
import { ApiError } from "../../../core/http/errors";
import { type ArticlePathConfig, buildArticlePath } from "../../../core/security/path-policy";
import type { GitProvider } from "../../../providers/git/types";
import type { RemoteArticle } from "../../../types/article";
import { parseMarkdownDocument } from "../../../utils/frontmatter-utils";
import { parseSlug } from "../../../utils/slug-utils";
import { summarizeArticleAssets } from "../../media/services/summarize-article-assets";

export interface ReadArticleDependencies {
	gitProvider: Pick<GitProvider, "getFile"> &
		Partial<Pick<GitProvider, "getFileAtCommit" | "getHead" | "listDirectoryAtCommit">>;
	pathConfig?: ArticlePathConfig;
	requireHeadSnapshot?: boolean;
	includeAssetDetails?: boolean;
}

/**
 * 从 Git Provider 读取文章，并在业务层重新建立文章数据边界。
 *
 * 输入只允许存储 slug，不能接收仓库路径；Provider 返回的路径也必须与服务端计算值
 * 完全一致。即便具体 Provider 或未来测试替身出现错误，也不会把其他仓库文件当成文章。
 */
export async function readArticle(
	storageSlugInput: unknown,
	dependencies: ReadArticleDependencies,
): Promise<RemoteArticle> {
	const storageSlug = parseSlug(storageSlugInput);
	const pathConfig = dependencies.pathConfig ?? articleConfig;
	const path = buildArticlePath(storageSlug, pathConfig);
	let headSha: string | undefined;
	let snapshotEntries: Awaited<ReturnType<GitProvider["listDirectoryAtCommit"]>> | undefined;
	let file: Awaited<ReturnType<GitProvider["getFile"]>>;
	if (dependencies.requireHeadSnapshot) {
		if (
			!dependencies.gitProvider.getHead ||
			!dependencies.gitProvider.getFileAtCommit ||
			!dependencies.gitProvider.listDirectoryAtCommit
		) {
			throw new ApiError(503, "CONFIGURATION_ERROR", "Git Provider 缺少一致性读取能力。");
		}
		const head = await dependencies.gitProvider.getHead();
		headSha = head.commitSha;
		const bundlePath = path.slice(0, -(pathConfig.entryFilename.length + 1));
		const snapshotFile = await dependencies.gitProvider.getFileAtCommit(path, headSha);
		file = snapshotFile;
		if (dependencies.includeAssetDetails !== false) {
			const entries = await dependencies.gitProvider.listDirectoryAtCommit(bundlePath, headSha);
			snapshotEntries = entries.filter((entry) => entry.name !== pathConfig.entryFilename);
		}
	} else {
		file = await dependencies.gitProvider.getFile(path);
	}

	if (file.path !== path || file.encoding !== "utf-8") {
		throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效文章文件。");
	}

	let parsed: ReturnType<typeof parseMarkdownDocument>;
	try {
		parsed = parseMarkdownDocument(file.content);
	} catch {
		// 仓库内容属于不可信外部数据，不能把 Zod/YAML 解析细节直接暴露给 API 调用者。
		throw new ApiError(422, "ARTICLE_INVALID", "远端文章格式无效，无法安全打开。");
	}
	const summarizedAssets =
		snapshotEntries === undefined
			? undefined
			: summarizeArticleAssets({
					storageSlug,
					frontmatterImage: parsed.frontmatter.image,
					markdown: parsed.markdown,
					entries: snapshotEntries,
					pathConfig,
				});
	const { updated, ...requiredFrontmatter } = parsed.frontmatter;
	return {
		storageSlug,
		// API 可返回稳定别名供编辑器展示，但不暴露仓库根目录或允许客户端回传完整路径。
		pathAlias: `${storageSlug}/index.md`,
		sha: file.sha,
		...(headSha === undefined ? {} : { headSha }),
		...(summarizedAssets === undefined
			? {}
			: {
					resources: summarizedAssets.resources,
					resourceReferenceAnalysis: summarizedAssets.referenceAnalysis,
				}),
		// exactOptionalPropertyTypes 下，可选日期缺失时必须省略字段，不能显式返回 undefined。
		frontmatter: updated === undefined ? requiredFrontmatter : { ...requiredFrontmatter, updated },
		...(parsed.slug === undefined ? {} : { slug: parsed.slug }),
		format: "md",
		markdown: parsed.markdown,
	};
}
