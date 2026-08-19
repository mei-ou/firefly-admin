import type { ArticleAssetSummary } from "../modules/media/article-asset";
import type { ArticleAssetReferenceAnalysisSummary } from "../modules/media/services/summarize-article-assets";

export type ArticleFormat = "md";

/**
 * Firefly 构建时真正读取的文章 Frontmatter。
 * prev/next 导航字段由主站构建流程计算，不属于后台可写数据，因此不出现在该类型中。
 */
export interface ArticleFrontmatter {
	title: string;
	published: Date;
	updated?: Date;
	draft: boolean;
	description: string;
	image: string;
	tags: string[];
	category: string | null;
	lang: string;
	pinned: boolean;
	author: string;
	sourceLink: string;
	licenseName: string;
	licenseUrl: string;
	comment: boolean;
	password: string;
	passwordHint: string;
}

/**
 * 编辑器提交到业务层的文章数据。slug 与 Frontmatter 分离，以便服务端独立执行
 * URL、冲突和路径策略；客户端不能通过该结构指定仓库文件路径。
 */
export interface ArticleEditorInput {
	frontmatter: ArticleFrontmatter;
	slug?: string;
	format: ArticleFormat;
	markdown: string;
}

/**
 * 从远端仓库打开并交给编辑器的数据。`storageSlug` 是服务端路径别名，`slug` 是文章
 * Frontmatter 可选声明；二者不能混为同一个值，否则自定义 URL 会破坏文件定位。
 */
export type RemoteArticleResource = ArticleAssetSummary;

export interface RemoteArticle extends ArticleEditorInput {
	storageSlug: string;
	pathAlias: string;
	sha: string;
	headSha?: string;
	/** 仅详情快照返回；每项都与 headSha 指向的不可变 Commit 一致。 */
	resources?: RemoteArticleResource[];
	/** 未完整识别所有本地引用时，资源不得被解释为“未引用”或低风险。 */
	resourceReferenceAnalysis?: ArticleAssetReferenceAnalysisSummary;
}

export interface ArticleSummary {
	storageSlug: string;
	slug?: string;
	title: string;
	published: Date;
	updated?: Date;
	draft: boolean;
	description: string;
	tags: string[];
	category: string | null;
	pinned: boolean;
}

export interface ArticleListResult {
	items: ArticleSummary[];
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
	candidateCount: number;
	scanned: number;
	skipped: number;
	truncated: boolean;
}

/** 写入远端仓库成功后的安全返回值，不暴露仓库根目录、分支或 Provider 原始响应。 */
export interface ArticleCommitResult {
	storageSlug: string;
	pathAlias: string;
	commitSha: string;
	commitUrl: string;
	fileSha: string;
}

/** 删除成功后不再存在文章 Blob，只返回已核对的删除路径集合和 Commit 身份。 */
export interface ArticleDeleteResult {
	storageSlug: string;
	pathAlias: string;
	commitSha: string;
	commitUrl: string;
	deletedFiles: string[];
}
