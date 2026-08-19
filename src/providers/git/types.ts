export interface GitRepositoryFile {
	path: string;
	sha: string;
	content: string;
	encoding: "utf-8";
}

export interface GitDirectoryEntry {
	name: string;
	path: string;
	sha: string;
	type: "file" | "directory";
	/** GitHub Contents API 对文件返回字节数；目录没有稳定文件大小，归一化为 null。 */
	size: number | null;
}

export interface CreateGitFileInput {
	path: string;
	content: string;
	message: string;
}

export interface UpdateGitFileInput extends CreateGitFileInput {
	/**
	 * 调用方读取文件时保存的 Blob SHA。Provider 必须把它作为乐观锁提交，不能在
	 * 冲突时静默读取新 SHA 后覆盖远端内容。
	 */
	expectedSha: string;
}

export interface CreateGitBinaryFileInput {
	path: string;
	content: Uint8Array;
	message: string;
}

export interface GitCommitResult {
	commitSha: string;
	commitUrl: string;
	fileSha: string;
	filePath: string;
}

export interface GitHead {
	commitSha: string;
	/** GitHub Provider 会返回已校验 URL；不支持该能力的 Provider 不能执行 unknown 恢复。 */
	commitUrl?: string;
	treeSha: string;
}

export interface AtomicGitWriteFileChange {
	/** 省略时仍表示写入，兼容现有服务调用；删除必须显式声明 operation。 */
	operation?: "write";
	path: string;
	content: string | Uint8Array;
	/** `null` 表示目标必须不存在；字符串表示目标 Blob 必须与读取时一致。 */
	expectedSha: string | null;
}

export interface AtomicGitDeleteFileChange {
	operation: "delete";
	path: string;
	/** 删除必须携带读取阶段保存的 Blob SHA，不允许把目标不存在视为成功。 */
	expectedSha: string;
}

export interface AtomicGitReuseFileChange {
	operation: "reuse";
	path: string;
	/** 目标必须不存在；Provider 会在同一 HEAD 快照验证这一条件。 */
	expectedSha: null;
	/** 已经由独立源路径 preflight 锁定的 Blob SHA；避免读取和重新编码二进制内容。 */
	fileSha: string;
}

export type AtomicGitFileChange =
	| AtomicGitWriteFileChange
	| AtomicGitDeleteFileChange
	| AtomicGitReuseFileChange;

export interface AtomicGitCommitInput {
	expectedHeadSha: string;
	message: string;
	files: readonly AtomicGitFileChange[];
	/**
	 * Provider 创建候选 Commit 后、更新 Ref 前的持久化屏障。失败时必须停止，确保没有
	 * 无检查点的分支副作用。
	 */
	checkpointCandidateCommit(commitSha: string): Promise<void>;
}

export interface AtomicGitCommitResult {
	commitSha: string;
	commitUrl: string;
	/** 删除项没有结果 Blob，因此 fileSha 为 null；调用方仍必须核对完整路径集合。 */
	files: readonly { path: string; fileSha: string | null }[];
}

/**
 * 业务层只依赖归一化后的 Git 能力，不感知 GitHub Contents API 的字段命名和错误结构。
 * 仓库、分支和鉴权由具体 Provider 的服务端配置决定，不属于方法输入。
 */
export interface GitProvider {
	/**
	 * 只列出指定仓库目录的直接子项。具体 Provider 必须设置响应数量上限，并拒绝任何
	 * 逃逸到请求目录之外或伪装成深层后代的上游条目。
	 */
	listDirectory(path: string): Promise<GitDirectoryEntry[]>;
	/** 在不可变 Commit 快照内列出目录，供文章详情与资源 Blob 锁共享同一 HEAD 基线。 */
	listDirectoryAtCommit(path: string, commitSha: string): Promise<GitDirectoryEntry[]>;
	getFile(path: string): Promise<GitRepositoryFile>;
	getFileAtCommit(path: string, commitSha: string): Promise<GitRepositoryFile>;
	getHead(): Promise<GitHead>;
	commitFilesAtomically(input: AtomicGitCommitInput): Promise<AtomicGitCommitResult>;
	createFile(input: CreateGitFileInput): Promise<GitCommitResult>;
	createBinaryFile(input: CreateGitBinaryFileInput): Promise<GitCommitResult>;
	updateFile(input: UpdateGitFileInput): Promise<GitCommitResult>;
}
