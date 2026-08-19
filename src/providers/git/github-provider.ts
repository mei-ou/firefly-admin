import { z } from "zod";
import { ApiError } from "../../core/http/errors";
import type {
	AtomicGitCommitInput,
	AtomicGitCommitResult,
	CreateGitBinaryFileInput,
	CreateGitFileInput,
	GitCommitResult,
	GitDirectoryEntry,
	GitHead,
	GitProvider,
	GitRepositoryFile,
	UpdateGitFileInput,
} from "./types";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_CONTENTS_API_FILE_BYTES = 1024 * 1024;
const MAX_ATOMIC_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 200;
const MAX_ATOMIC_FILES = 11;
const SAFE_REPOSITORY_NAME = /^[A-Za-z0-9_.-]+$/;
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_REPOSITORY_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;

const githubContentsFileSchema = z
	.object({
		type: z.literal("file"),
		path: z.string().min(1).max(512),
		sha: z.string().regex(GIT_OBJECT_SHA),
		encoding: z.literal("base64"),
		content: z.string(),
		size: z.number().int().nonnegative().max(MAX_CONTENTS_API_FILE_BYTES),
	})
	.strict();

const githubContentsMetadataSchema = z.looseObject({
	type: z.literal("file"),
	path: z.string().min(1).max(512),
	sha: z.string().regex(GIT_OBJECT_SHA),
});

const githubDirectoryEntrySchema = z.looseObject({
	name: z.string().min(1).max(100),
	path: z.string().min(1).max(512),
	sha: z.string().regex(GIT_OBJECT_SHA),
	type: z.enum(["file", "dir"]),
	// 列表需要观察超出写入门限的既有文件；大小只要求是可安全表示的非负整数。
	size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const githubDirectorySchema = z.array(githubDirectoryEntrySchema).max(MAX_DIRECTORY_ENTRIES);

const githubCommitResponseSchema = z.looseObject({
	content: z.looseObject({
		path: z.string().min(1).max(512),
		sha: z.string().regex(GIT_OBJECT_SHA),
	}),
	commit: z.looseObject({
		sha: z.string().regex(GIT_OBJECT_SHA),
		html_url: z.url().refine((value) => new URL(value).origin === "https://github.com"),
	}),
});

const githubErrorSchema = z.looseObject({
	message: z.string().optional(),
});

const githubRefSchema = z.looseObject({
	object: z.looseObject({
		type: z.literal("commit"),
		sha: z.string().regex(GIT_OBJECT_SHA),
	}),
});

const githubGitCommitSchema = z.looseObject({
	sha: z.string().regex(GIT_OBJECT_SHA),
	html_url: z.url().refine((value) => new URL(value).origin === "https://github.com"),
	tree: z.looseObject({ sha: z.string().regex(GIT_OBJECT_SHA) }),
});

const githubBlobSchema = z.looseObject({
	sha: z.string().regex(GIT_OBJECT_SHA),
});

const githubTreeSchema = z.looseObject({
	sha: z.string().regex(GIT_OBJECT_SHA),
});

const githubCreatedCommitSchema = z.looseObject({
	sha: z.string().regex(GIT_OBJECT_SHA),
	html_url: z.url().refine((value) => new URL(value).origin === "https://github.com"),
});

export interface GitHubProviderConfig {
	owner: string;
	repo: string;
	branch: string;
	token: string;
}

export interface GitHubProviderDependencies {
	fetch?: typeof fetch;
}

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
	});
}

function sanitizeDiagnosticMessage(value: string): string {
	return Array.from(value, (character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127) ? " " : character;
	})
		.join("")
		.slice(0, 200);
}

function parseRepositoryName(value: string, label: string): string {
	if (
		value.length === 0 ||
		value.length > 100 ||
		value !== value.normalize("NFKC") ||
		!SAFE_REPOSITORY_NAME.test(value) ||
		value === "." ||
		value === ".."
	) {
		throw new TypeError(`${label} 配置无效。`);
	}

	return value;
}

function parseBranch(value: string): string {
	if (
		value.length === 0 ||
		value.length > 255 ||
		value !== value.normalize("NFKC") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("..") ||
		value.includes("//") ||
		value.includes("@{") ||
		value.endsWith(".lock") ||
		containsControlCharacter(value) ||
		!SAFE_GIT_REF.test(value)
	) {
		throw new TypeError("GitHub 分支配置无效。");
	}

	return value;
}

/**
 * 路径只接受已经由服务端策略生成的仓库相对路径。这里再次验证是纵深防御，避免未来
 * 其他模块绕过文章路径构造器后把 Contents API 变成任意仓库文件读写接口。
 */
function parseRepositoryPath(value: string): string {
	if (
		value.length === 0 ||
		value.length > 512 ||
		value !== value.normalize("NFKC") ||
		value.startsWith("/") ||
		value.endsWith("/") ||
		value.includes("\\") ||
		value.includes("%") ||
		value.includes(":") ||
		containsControlCharacter(value)
	) {
		throw new TypeError("GitHub 仓库路径无效。");
	}

	const segments = value.split("/");
	if (
		segments.some(
			(segment) =>
				segment === "." || segment === ".." || !SAFE_REPOSITORY_PATH_SEGMENT.test(segment),
		)
	) {
		throw new TypeError("GitHub 仓库路径无效。");
	}

	return segments.join("/");
}

/** 仓库浏览器可以从根目录开始，但文件读取和写入仍必须使用非空路径。 */
function parseDirectoryPath(value: string): string {
	return value === "" ? "" : parseRepositoryPath(value);
}

function parseCommitMessage(value: string): string {
	if (
		value.length === 0 ||
		value.length > 200 ||
		value.trim() !== value ||
		containsControlCharacter(value)
	) {
		throw new TypeError("Git 提交信息无效。");
	}
	return value;
}

function parseContent(value: string): string {
	if (new TextEncoder().encode(value).byteLength > MAX_CONTENTS_API_FILE_BYTES) {
		throw new TypeError("Git 文件内容超过大小限制。");
	}
	return value;
}

function parseGitObjectSha(value: string): string {
	if (!GIT_OBJECT_SHA.test(value)) {
		throw new TypeError("Git 对象 SHA 无效。");
	}
	return value;
}

type ParsedAtomicFile =
	| { operation: "write"; path: string; content: string; expectedSha: string | null }
	| { operation: "delete"; path: string; expectedSha: string }
	| { operation: "reuse"; path: string; expectedSha: null; fileSha: string };

function parseAtomicFiles(input: AtomicGitCommitInput["files"]): ParsedAtomicFile[] {
	if (input.length === 0 || input.length > MAX_ATOMIC_FILES) {
		throw new TypeError("原子提交文件数量无效。");
	}
	const seenPaths = new Set<string>();
	return input.map((file) => {
		const path = parseRepositoryPath(file.path);
		if (seenPaths.has(path)) throw new TypeError("原子提交包含重复路径。");
		seenPaths.add(path);
		if (file.operation === "delete") {
			return { operation: "delete", path, expectedSha: parseGitObjectSha(file.expectedSha) };
		}
		if (file.operation === "reuse") {
			return {
				operation: "reuse",
				path,
				expectedSha: null,
				fileSha: parseGitObjectSha(file.fileSha),
			};
		}
		return {
			operation: "write",
			path,
			content:
				typeof file.content === "string"
					? encodeUtf8Base64(file.content, MAX_ATOMIC_FILE_BYTES)
					: encodeBytesBase64(file.content, MAX_ATOMIC_FILE_BYTES),
			expectedSha: file.expectedSha === null ? null : parseGitObjectSha(file.expectedSha),
		};
	});
}

function encodeBytesBase64(bytes: Uint8Array, maxBytes = MAX_CONTENTS_API_FILE_BYTES): string {
	if (bytes.byteLength > maxBytes) {
		throw new TypeError("Git 文件内容超过大小限制。");
	}
	const chunks: string[] = [];
	const chunkSize = 32 * 1024;
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
	}
	return btoa(chunks.join(""));
}

function encodeUtf8Base64(value: string, maxBytes = MAX_CONTENTS_API_FILE_BYTES): string {
	return encodeBytesBase64(new TextEncoder().encode(value), maxBytes);
}

function decodeUtf8Base64(value: string): string {
	try {
		const compactValue = value.replace(/\s/g, "");
		const binary = atob(compactValue);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
	}
}

async function readResponseBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
	}
}

function mapGitHubError(response: Response, body: unknown): ApiError {
	const message = githubErrorSchema.safeParse(body).success
		? githubErrorSchema.parse(body).message
		: undefined;

	if (response.status === 404) {
		return new ApiError(404, "NOT_FOUND", "远端文件不存在。");
	}
	if (response.status === 409 || response.status === 422) {
		// GitHub 对旧 SHA 或不可更新状态可能返回 409/422，业务层统一视为并发冲突。
		return new ApiError(409, "CONFLICT", "远端文件已经变化，请重新加载后再提交。");
	}
	if (response.status === 401 || response.status === 403) {
		return new ApiError(502, "UPSTREAM_ERROR", "Git 服务暂时不可用。");
	}
	if (response.status === 429 || response.status >= 500) {
		return new ApiError(503, "UPSTREAM_UNAVAILABLE", "Git 服务暂时不可用。");
	}

	// 只用上游 message 做有限分类，绝不将可能包含仓库或策略细节的原文返回客户端。
	if (message?.toLowerCase().includes("sha")) {
		return new ApiError(409, "CONFLICT", "远端文件已经变化，请重新加载后再提交。");
	}
	return new ApiError(502, "UPSTREAM_ERROR", "Git 服务请求失败。");
}

/**
 * GitHub Contents API Provider。配置和 Token 必须由 Worker 环境注入；构造函数会立即
 * 校验固定仓库边界，但不会发起网络请求，便于在模块关闭时完全避免外部访问。
 */
export class GitHubProvider implements GitProvider {
	readonly #owner: string;
	readonly #repo: string;
	readonly #branch: string;
	readonly #authorization: string;
	readonly #fetch: typeof fetch;

	constructor(config: GitHubProviderConfig, dependencies: GitHubProviderDependencies = {}) {
		this.#owner = parseRepositoryName(config.owner, "GitHub Owner");
		this.#repo = parseRepositoryName(config.repo, "GitHub Repo");
		this.#branch = parseBranch(config.branch);
		if (config.token.length === 0 || containsControlCharacter(config.token)) {
			throw new TypeError("GitHub Token 配置无效。");
		}
		this.#authorization = `Bearer ${config.token}`;
		this.#fetch = (dependencies.fetch ?? globalThis.fetch).bind(globalThis);
	}

	async listDirectory(pathInput: string): Promise<GitDirectoryEntry[]> {
		return this.#listDirectoryAtRef(pathInput, this.#branch);
	}

	async listDirectoryAtCommit(
		pathInput: string,
		commitShaInput: string,
	): Promise<GitDirectoryEntry[]> {
		return this.#listDirectoryAtRef(pathInput, parseGitObjectSha(commitShaInput));
	}

	async #listDirectoryAtRef(pathInput: string, ref: string): Promise<GitDirectoryEntry[]> {
		const path = parseDirectoryPath(pathInput);
		const response = await this.#requestApi(this.#contentsApiPath(path, ref), { method: "GET" });
		const body = await readResponseBody(response);
		if (!response.ok) {
			throw mapGitHubError(response, body);
		}

		const result = githubDirectorySchema.safeParse(body);
		if (!result.success) {
			throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
		}

		const directChildPrefix = path === "" ? "" : `${path}/`;
		const entries: GitDirectoryEntry[] = [];
		const seenNames = new Set<string>();
		for (const entry of result.data) {
			let normalizedName: string;
			let normalizedPath: string;
			try {
				normalizedName = parseRepositoryPath(entry.name);
				normalizedPath = parseRepositoryPath(entry.path);
			} catch {
				throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
			}

			// Contents API 理应只返回直接子项；仍逐项核对路径，避免上游异常响应扩大读取边界。
			if (
				normalizedName.includes("/") ||
				normalizedPath !== `${directChildPrefix}${normalizedName}` ||
				seenNames.has(normalizedName)
			) {
				throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
			}
			seenNames.add(normalizedName);
			entries.push({
				name: normalizedName,
				path: normalizedPath,
				sha: entry.sha,
				type: entry.type === "dir" ? "directory" : "file",
				size: entry.type === "dir" ? null : entry.size,
			});
		}

		return entries;
	}

	async getFile(pathInput: string): Promise<GitRepositoryFile> {
		return this.#getFileAtRef(pathInput, this.#branch);
	}

	async getFileAtCommit(pathInput: string, commitShaInput: string): Promise<GitRepositoryFile> {
		return this.#getFileAtRef(pathInput, parseGitObjectSha(commitShaInput));
	}

	async #getFileAtRef(pathInput: string, ref: string): Promise<GitRepositoryFile> {
		const path = parseRepositoryPath(pathInput);
		const response = await this.#requestApi(this.#contentsApiPath(path, ref), { method: "GET" });
		const body = await readResponseBody(response);
		if (!response.ok) {
			throw mapGitHubError(response, body);
		}

		const result = githubContentsFileSchema.safeParse(body);
		if (!result.success || result.data.path !== path) {
			throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
		}

		return {
			path: result.data.path,
			sha: result.data.sha,
			content: decodeUtf8Base64(result.data.content),
			encoding: "utf-8",
		};
	}

	async getHead(): Promise<GitHead> {
		const refBody = await this.#requestJson(
			`/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/git/ref/heads/${this.#encodedBranch()}`,
			{ method: "GET" },
		);
		const ref = githubRefSchema.safeParse(refBody);
		if (!ref.success) throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");

		const commitBody = await this.#requestJson(
			`/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/git/commits/${ref.data.object.sha}`,
			{ method: "GET" },
		);
		const commit = githubGitCommitSchema.safeParse(commitBody);
		if (!commit.success || commit.data.sha !== ref.data.object.sha) {
			throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
		}
		return {
			commitSha: commit.data.sha,
			commitUrl: commit.data.html_url,
			treeSha: commit.data.tree.sha,
		};
	}

	async commitFilesAtomically(input: AtomicGitCommitInput): Promise<AtomicGitCommitResult> {
		const expectedHeadSha = parseGitObjectSha(input.expectedHeadSha);
		const message = parseCommitMessage(input.message);
		const files = parseAtomicFiles(input.files);
		const head = await this.getHead();
		if (head.commitSha !== expectedHeadSha) {
			throw new ApiError(409, "CONFLICT", "远端分支已经变化，请重新加载后再提交。");
		}

		// 文件级 preflight 在创建任何 Git 对象前完成，避免已知冲突产生无用对象。
		for (const file of files) {
			const response = await this.#requestApi(this.#contentsApiPath(file.path, expectedHeadSha), {
				method: "GET",
			});
			if (file.expectedSha === null && response.status === 404) continue;
			const body = await readResponseBody(response);
			if (!response.ok) {
				if (file.operation === "delete" && response.status === 404) {
					throw new ApiError(409, "CONFLICT", "远端文件已经变化，请重新加载后再提交。");
				}
				throw mapGitHubError(response, body);
			}
			const metadata = githubContentsMetadataSchema.safeParse(body);
			if (
				!metadata.success ||
				metadata.data.path !== file.path ||
				file.expectedSha === null ||
				metadata.data.sha !== file.expectedSha
			) {
				throw new ApiError(409, "CONFLICT", "远端文件已经变化，请重新加载后再提交。");
			}
		}

		const committedFiles: Array<{ path: string; fileSha: string | null }> = [];
		for (const file of files) {
			if (file.operation === "delete") {
				committedFiles.push({ path: file.path, fileSha: null });
				continue;
			}
			if (file.operation === "reuse") {
				committedFiles.push({ path: file.path, fileSha: file.fileSha });
				continue;
			}
			const body = await this.#requestJson(
				`/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/git/blobs`,
				{ method: "POST", body: JSON.stringify({ content: file.content, encoding: "base64" }) },
			);
			const blob = githubBlobSchema.safeParse(body);
			if (!blob.success) throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
			committedFiles.push({ path: file.path, fileSha: blob.data.sha });
		}

		const treeBody = await this.#requestJson(
			`/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/git/trees`,
			{
				method: "POST",
				body: JSON.stringify({
					base_tree: head.treeSha,
					tree: committedFiles.map((file) => ({
						path: file.path,
						mode: "100644",
						type: "blob",
						sha: file.fileSha,
					})),
				}),
			},
		);
		const tree = githubTreeSchema.safeParse(treeBody);
		if (!tree.success) throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");

		const commitBody = await this.#requestJson(
			`/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/git/commits`,
			{
				method: "POST",
				body: JSON.stringify({ message, tree: tree.data.sha, parents: [expectedHeadSha] }),
			},
		);
		const commit = githubCreatedCommitSchema.safeParse(commitBody);
		if (!commit.success) throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");

		await input.checkpointCandidateCommit(commit.data.sha);
		const refPath = `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/git/refs/heads/${this.#encodedBranch()}`;
		let refResponse: Response;
		try {
			refResponse = await this.#requestApi(refPath, {
				method: "PATCH",
				body: JSON.stringify({ sha: commit.data.sha, force: false }),
			});
		} catch {
			throw new ApiError(503, "COMMIT_STATUS_UNKNOWN", "提交状态暂时无法确认，请勿重复提交。");
		}
		let refResult: unknown;
		try {
			refResult = await refResponse.json();
		} catch {
			throw new ApiError(503, "COMMIT_STATUS_UNKNOWN", "提交状态暂时无法确认，请勿重复提交。");
		}
		if (!refResponse.ok) {
			if (refResponse.status === 409 || refResponse.status === 422) {
				throw mapGitHubError(refResponse, refResult);
			}
			throw new ApiError(503, "COMMIT_STATUS_UNKNOWN", "提交状态暂时无法确认，请勿重复提交。");
		}
		const updatedRef = githubRefSchema.safeParse(refResult);
		if (!updatedRef.success || updatedRef.data.object.sha !== commit.data.sha) {
			throw new ApiError(503, "COMMIT_STATUS_UNKNOWN", "提交状态暂时无法确认，请勿重复提交。");
		}

		return {
			commitSha: commit.data.sha,
			commitUrl: commit.data.html_url,
			files: committedFiles,
		};
	}

	async createFile(input: CreateGitFileInput): Promise<GitCommitResult> {
		return this.#writeEncodedFile(
			input.path,
			input.message,
			encodeUtf8Base64(parseContent(input.content)),
		);
	}

	async createBinaryFile(input: CreateGitBinaryFileInput): Promise<GitCommitResult> {
		return this.#writeEncodedFile(input.path, input.message, encodeBytesBase64(input.content));
	}

	async updateFile(input: UpdateGitFileInput): Promise<GitCommitResult> {
		return this.#writeEncodedFile(
			input.path,
			input.message,
			encodeUtf8Base64(parseContent(input.content)),
			parseGitObjectSha(input.expectedSha),
		);
	}

	async #writeEncodedFile(
		pathInput: string,
		messageInput: string,
		content: string,
		expectedSha?: string,
	): Promise<GitCommitResult> {
		const path = parseRepositoryPath(pathInput);
		const payload: Record<string, string> = {
			message: parseCommitMessage(messageInput),
			content,
			branch: this.#branch,
		};
		if (expectedSha !== undefined) {
			payload.sha = expectedSha;
		}

		const response = await this.#request(path, {
			method: "PUT",
			body: JSON.stringify(payload),
		});
		const body = await readResponseBody(response);
		if (!response.ok) {
			throw mapGitHubError(response, body);
		}

		const result = githubCommitResponseSchema.safeParse(body);
		if (!result.success || result.data.content.path !== path) {
			throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
		}

		return {
			commitSha: result.data.commit.sha,
			commitUrl: result.data.commit.html_url,
			fileSha: result.data.content.sha,
			filePath: result.data.content.path,
		};
	}

	#encodedBranch(): string {
		return this.#branch.split("/").map(encodeURIComponent).join("/");
	}

	#contentsApiPath(path: string, ref = this.#branch): string {
		const encodedPath = path.split("/").map(encodeURIComponent).join("/");
		const base = `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/contents`;
		const url = new URL(encodedPath ? `${base}/${encodedPath}` : base, GITHUB_API_ORIGIN);
		url.searchParams.set("ref", ref);
		return `${url.pathname}${url.search}`;
	}

	async #request(path: string, init: RequestInit): Promise<Response> {
		const apiPath = this.#contentsApiPath(path);
		// Contents API 的 PUT 不接受 ref 查询参数，目标分支由 payload.branch 明确指定。
		return this.#requestApi(
			init.method === "GET" ? apiPath : (apiPath.split("?")[0] ?? apiPath),
			init,
		);
	}

	async #requestJson(path: string, init: RequestInit): Promise<unknown> {
		const response = await this.#requestApi(path, init);
		const body = await readResponseBody(response);
		if (!response.ok) throw mapGitHubError(response, body);
		return body;
	}

	async #requestApi(path: string, init: RequestInit): Promise<Response> {
		const url = new URL(path, GITHUB_API_ORIGIN);
		const method = init.method ?? "GET";
		try {
			const response = await this.#fetch(url, {
				...init,
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: this.#authorization,
					"Content-Type": "application/json",
					"X-GitHub-Api-Version": GITHUB_API_VERSION,
				},
			});
			if (!response.ok) {
				// 只记录可定位上游故障所需的元数据；禁止记录 Token、正文和响应原文。
				console.error("github-upstream", {
					upstream: "github",
					method,
					path: url.pathname,
					status: response.status,
					rateLimitRemaining: response.headers.get("x-ratelimit-remaining"),
					rateLimitReset: response.headers.get("x-ratelimit-reset"),
					retryAfter: response.headers.get("retry-after"),
				});
			}
			return response;
		} catch (error) {
			console.error("github-network", {
				upstream: "github",
				method,
				path: url.pathname,
				failure: "network",
				errorName: error instanceof Error ? error.name : typeof error,
				errorMessage: error instanceof Error ? sanitizeDiagnosticMessage(error.message) : "unknown",
			});
			throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "Git 服务暂时不可用。");
		}
	}
}
