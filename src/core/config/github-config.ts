import { z } from "zod";
import { ApiError } from "../http/errors";

const SAFE_REPOSITORY_NAME = /^[A-Za-z0-9_.-]+$/;
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
	});
}

const repositoryNameSchema = z
	.string()
	.min(1)
	.max(100)
	.refine((value) => value === value.normalize("NFKC"))
	.refine((value) => value !== "." && value !== ".." && SAFE_REPOSITORY_NAME.test(value));

const branchSchema = z
	.string()
	.min(1)
	.max(255)
	.refine((value) => value === value.normalize("NFKC"))
	.refine((value) => !containsControlCharacter(value))
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.endsWith("/") &&
			!value.includes("..") &&
			!value.includes("//") &&
			!value.includes("@{") &&
			!value.endsWith(".lock") &&
			SAFE_GIT_REF.test(value),
	);

const contentRootSchema = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => value === value.normalize("NFKC"))
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.endsWith("/") &&
			!value.includes("\\") &&
			!value.includes("%") &&
			!value.includes(":") &&
			!containsControlCharacter(value),
	)
	.refine((value) =>
		value
			.split("/")
			.every((segment) => segment !== "." && segment !== ".." && SAFE_PATH_SEGMENT.test(segment)),
	);

const githubEnvSchema = z
	.object({
		GITHUB_OWNER: repositoryNameSchema,
		GITHUB_REPO: repositoryNameSchema,
		GITHUB_BRANCH: branchSchema,
		GITHUB_CONTENT_ROOT: contentRootSchema,
		GITHUB_TOKEN: z
			.string()
			.min(1)
			.max(4096)
			.refine((value) => !containsControlCharacter(value)),
	})
	.strip();

export interface GitHubRuntimeConfig {
	owner: string;
	repo: string;
	branch: string;
	contentRoot: string;
	entryFilename: "index.md";
	usePageBundle: true;
	token: string;
}

/**
 * GitHub 配置不并入全局 Access 配置：页面只读请求不应因为尚未配置 GitHub 而整体
 * 下线。只有文章模块真正初始化 Git Provider 时才读取并验证这些值，缺失则失败关闭。
 */
export function loadGitHubConfig(input: unknown): GitHubRuntimeConfig {
	const result = githubEnvSchema.safeParse(input);
	if (!result.success) {
		// 不暴露究竟缺少 Token、仓库名还是分支，避免远端调用者探测部署细节。
		throw new ApiError(503, "CONFIGURATION_ERROR", "Git 服务尚未正确配置。");
	}

	return {
		owner: result.data.GITHUB_OWNER,
		repo: result.data.GITHUB_REPO,
		branch: result.data.GITHUB_BRANCH,
		contentRoot: result.data.GITHUB_CONTENT_ROOT,
		// P1 固定 Page Bundle Markdown；配置对象同时作为文章路径策略的唯一服务端来源。
		entryFilename: "index.md",
		usePageBundle: true,
		token: result.data.GITHUB_TOKEN,
	};
}
