import { z } from "zod";
import type { GitDirectoryEntry, GitProvider } from "../../../providers/git/types";

const SAFE_REPOSITORY_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const repositoryDirectoryQuerySchema = z.object({ path: z.string().max(512).default("") }).strict();

export interface RepositoryDirectoryResult {
	path: string;
	parentPath: string | null;
	entries: GitDirectoryEntry[];
}

function containsControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
	});
}

/** 只接受规范仓库相对目录；根目录用空字符串表示，绝不接收 owner、repo 或 branch。 */
export function parseRepositoryDirectoryPath(input: unknown): string {
	const { path } = repositoryDirectoryQuerySchema.parse({ path: input ?? "" });
	if (path === "") return "";
	if (
		path !== path.normalize("NFKC") ||
		path.startsWith("/") ||
		path.endsWith("/") ||
		path.includes("\\") ||
		path.includes("%") ||
		path.includes(":") ||
		containsControlCharacter(path)
	) {
		throw new TypeError("仓库目录路径无效。");
	}
	const segments = path.split("/");
	if (
		segments.some(
			(segment) =>
				segment === "." || segment === ".." || !SAFE_REPOSITORY_PATH_SEGMENT.test(segment),
		)
	) {
		throw new TypeError("仓库目录路径无效。");
	}
	return segments.join("/");
}

export async function listRepositoryDirectory(
	pathInput: unknown,
	dependencies: { gitProvider: Pick<GitProvider, "listDirectory"> },
): Promise<RepositoryDirectoryResult> {
	const path = parseRepositoryDirectoryPath(pathInput);
	const entries = await dependencies.gitProvider.listDirectory(path);
	entries.sort((left, right) => {
		if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
		return left.name.localeCompare(right.name);
	});
	const separatorIndex = path.lastIndexOf("/");
	return {
		path,
		parentPath: path === "" ? null : separatorIndex < 0 ? "" : path.slice(0, separatorIndex),
		entries,
	};
}
