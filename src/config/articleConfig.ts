export const articleConfig = {
	// 内容位置只由服务端配置决定，浏览器请求不能覆盖仓库根目录或分支。
	contentRoot: "src/content/posts",
	branch: "master",
	usePageBundle: true,
	entryFilename: "index.md",
	defaultLanguage: "zh_CN",
	defaultComment: true,
	defaultDraft: true,
	allowDelete: false,
	allowDirectPublish: true,
	allowPullRequestPublish: false,
	// MDX 可执行表达式和组件，P1 必须保持关闭，直到单独设计发布安全模型。
	enableMdx: false,
} as const;
