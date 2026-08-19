import { z } from "zod";

const gitObjectShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

const repositoryEntrySchema = z
	.object({
		name: z.string().min(1).max(100),
		path: z.string().min(1).max(512),
		sha: gitObjectShaSchema,
		type: z.enum(["file", "directory"]),
	})
	.strict();

const repositoryDirectoryPayloadSchema = z
	.object({
		directory: z
			.object({
				path: z.string().max(512),
				parentPath: z.string().max(512).nullable(),
				entries: z.array(repositoryEntrySchema).max(200),
			})
			.strict(),
	})
	.strict();

export type RepositoryEntry = z.infer<typeof repositoryEntrySchema>;
export type RepositoryDirectory = z.infer<typeof repositoryDirectoryPayloadSchema>["directory"];

/** 仓库浏览响应只保留路径、类型和 SHA，不接受任何服务端仓库配置或原始 API 字段。 */
export function parseRepositoryDirectoryPayload(value: unknown): RepositoryDirectory {
	return repositoryDirectoryPayloadSchema.parse(value).directory;
}

export function isImageRepositoryEntry(entry: RepositoryEntry): boolean {
	if (entry.type !== "file") return false;
	return /\.(?:avif|gif|jpe?g|png|svg|webp)$/iu.test(entry.name);
}
