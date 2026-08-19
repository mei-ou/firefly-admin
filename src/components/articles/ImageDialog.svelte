<script lang="ts">
import { onDestroy } from "svelte";
import {
	ARTICLE_ASSET_ATTACHMENT_MAX_BYTES,
	ARTICLE_ASSET_IMAGE_MAX_BYTES,
	deriveStagedArticleAssetPath,
	isMediaFilenameCompatible,
	isMediaStagingContentType,
} from "../../modules/media/media-config";
import type { AdminCapabilitySnapshot } from "../../types/capability";
import { createMarkdownImage } from "./editor-commands";
import { parseArticleRelativeImagePath, parseRemoteImageUrl } from "./markdown-target-validation";
import {
	createLocalMediaKey,
	createLocalStagedAssetRecord,
	createUploadedLocalStagedAssetRecord,
	listLocalStagedAssets,
	removeLocalStagedAsset,
	upsertLocalStagedAsset,
} from "./media-local-staging";
import { isR2StagingUnavailable, type StagedMediaAsset, stageMediaAsset } from "./media-staging";
import RepositoryBrowser from "./RepositoryBrowser.svelte";
import type { RepositoryEntry } from "./repository-directory";

type ImageSource = "attachment" | "upload" | "repository" | "remote";

interface Props {
	open: boolean;
	capabilities: AdminCapabilitySnapshot;
	mediaDraftKey?: string;
	mode: "create" | "edit";
	storageSlug?: string;
	onclose: () => void;
	oninsert: (markdown: string) => void;
	onstaged?: () => void;
}

let {
	open,
	capabilities,
	mediaDraftKey = "",
	mode,
	storageSlug = "",
	onclose,
	oninsert,
	onstaged = () => undefined,
}: Props = $props();
let source = $state<ImageSource>(
	capabilities.externalHttpsLinks
		? "remote"
		: capabilities.smallImageUpload
			? "upload"
			: capabilities.pdfAttachmentUpload
				? "attachment"
				: "remote",
);
let alt = $state("");
let title = $state("");
let remoteUrl = $state("");
let repositoryPath = $state("");
let errorMessage = $state("");
let previewUrl = $state("");
let repositoryBrowserOpen = $state(false);
let uploadFile = $state<File | null>(null);
let uploadPreviewUrl = $state("");
let uploading = $state(false);
let stagedAsset = $state<StagedMediaAsset | null>(null);
let localRecordId = $state("");
let locallyStaged = $state(false);
let localStageMessage = $state("");
let uploadController: AbortController | undefined;
let uploadSequence = 0;
let restoredLocalKey = "";
let localRestoreSequence = 0;
let savingStagedAsset = $state(false);

const isAttachmentSource = $derived(source === "attachment");
const selectedAssetLabel = $derived(isAttachmentSource ? "附件" : "图片");

const articleDirectory = $derived(
	storageSlug ? `src/content/posts/${storageSlug}` : "src/content/posts",
);

function revokeUploadPreview(): void {
	if (uploadPreviewUrl) URL.revokeObjectURL(uploadPreviewUrl);
	uploadPreviewUrl = "";
}

function resetUploadState(): void {
	localRestoreSequence += 1;
	uploadSequence += 1;
	uploadController?.abort();
	uploadController = undefined;
	uploading = false;
	savingStagedAsset = false;
	stagedAsset = null;
	localRecordId = "";
	locallyStaged = false;
	localStageMessage = "";
}

function localMediaKey(): string | null {
	if (mediaDraftKey) return mediaDraftKey;
	// 兼容父组件尚未接入稳定 key 的编辑页；新建页必须由父组件提供 create:<draft-id>。
	if (mode !== "edit" || !storageSlug) return null;
	return createLocalMediaKey(storageSlug);
}

function close(): void {
	resetUploadState();
	localRestoreSequence += 1;
	restoredLocalKey = "";
	revokeUploadPreview();
	uploadFile = null;
	errorMessage = "";
	onclose();
}

async function selectUploadFile(event: Event): Promise<void> {
	resetUploadState();
	revokeUploadPreview();
	errorMessage = "";
	const input = event.currentTarget as HTMLInputElement;
	uploadFile = input.files?.[0] ?? null;
	if (!uploadFile) return;
	const isAttachment = source === "attachment";
	const maxBytes = isAttachment
		? ARTICLE_ASSET_ATTACHMENT_MAX_BYTES
		: ARTICLE_ASSET_IMAGE_MAX_BYTES;
	if (uploadFile.size === 0 || uploadFile.size > maxBytes) {
		errorMessage = isAttachment
			? "附件必须非空且不能超过 4 MiB。"
			: "图片必须非空且不能超过 1 MiB。";
		uploadFile = null;
		input.value = "";
		return;
	}
	const allowedTypes = isAttachment
		? ["application/pdf"]
		: ["image/jpeg", "image/png", "image/webp"];
	if (!allowedTypes.includes(uploadFile.type)) {
		errorMessage = isAttachment
			? "附件当前仅支持 PDF；ZIP 默认关闭，待独立内容审计与风险确认后再开放。"
			: "仅支持 JPEG、PNG 和 WebP 图片。";
		uploadFile = null;
		input.value = "";
		return;
	}
	if (
		!isMediaStagingContentType(uploadFile.type) ||
		!isMediaFilenameCompatible(uploadFile.name, uploadFile.type)
	) {
		errorMessage = "文件扩展名必须与格式一致，且不能使用双扩展名。";
		uploadFile = null;
		input.value = "";
		return;
	}
	if (!isAttachment) uploadPreviewUrl = URL.createObjectURL(uploadFile);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

async function restoreLocalUpload(key: string, attachment: boolean): Promise<void> {
	const restoreKey = `${key}:${attachment ? "attachment" : "image"}`;
	const sequence = ++localRestoreSequence;
	try {
		const listed = await listLocalStagedAssets(key);
		if (sequence !== localRestoreSequence || restoredLocalKey !== restoreKey || !listed) return;
		const record = [...listed.records]
			.reverse()
			.find((entry) =>
				attachment
					? entry.contentType === "application/pdf"
					: entry.contentType.startsWith("image/"),
			);
		if (!record) return;
		uploadFile = new File([record.blob], record.filename, { type: record.contentType });
		revokeUploadPreview();
		if (!attachment) uploadPreviewUrl = URL.createObjectURL(uploadFile);
		localRecordId = record.localId;
		if (record.r2) {
			stagedAsset = {
				id: record.r2.assetId,
				objectKey: record.r2.objectKey,
				filename: record.filename,
				contentType: record.contentType as StagedMediaAsset["contentType"],
				size: record.size,
				etag: record.r2.etag,
				uploadedAt: record.r2.uploadedAt,
			};
			locallyStaged = false;
			localStageMessage = "";
		} else {
			locallyStaged = true;
			localStageMessage = `已恢复浏览器本地暂存${attachment ? "附件" : "图片"}。该资源尚未上传；R2 恢复后请点击“重新尝试 R2 上传”。`;
		}
	} catch (error) {
		if (sequence !== localRestoreSequence || restoredLocalKey !== restoreKey) return;
		errorMessage =
			error instanceof Error ? error.message : `恢复本地暂存${attachment ? "附件" : "图片"}失败。`;
	}
}

function selectSource(nextSource: ImageSource): void {
	if (
		(nextSource === "remote" && !capabilities.externalHttpsLinks) ||
		(nextSource === "upload" && !capabilities.smallImageUpload) ||
		(nextSource === "attachment" && !capabilities.pdfAttachmentUpload) ||
		(nextSource === "repository" && !capabilities.repositoryBrowser)
	) {
		return;
	}
	if (source === nextSource) return;
	resetUploadState();
	revokeUploadPreview();
	uploadFile = null;
	errorMessage = "";
	restoredLocalKey = "";
	source = nextSource;
}

$effect(() => {
	const key = open ? localMediaKey() : null;
	if (!key || (source !== "upload" && source !== "attachment")) return;
	const restoreKey = `${key}:${source === "attachment" ? "attachment" : "image"}`;
	if (restoredLocalKey === restoreKey) return;
	restoredLocalKey = restoreKey;
	void restoreLocalUpload(key, source === "attachment");
});

async function uploadToR2(): Promise<void> {
	if (!uploadFile || uploading || savingStagedAsset) return;
	const file = uploadFile;
	errorMessage = "";
	stagedAsset = null;
	uploadController?.abort();
	const controller = new AbortController();
	uploadController = controller;
	const sequence = ++uploadSequence;
	uploading = true;
	try {
		const asset = await stageMediaAsset(file, { signal: controller.signal });
		if (sequence !== uploadSequence || controller !== uploadController) return;
		const key = localMediaKey();
		if (!key) throw new TypeError("当前文章缺少稳定的本地资源草稿身份。");
		const record = createUploadedLocalStagedAssetRecord({
			asset,
			draftKey: key,
			file,
			role: file.type.startsWith("image/") ? "inline" : "attachment",
		});
		const saved = await upsertLocalStagedAsset(record);
		if (sequence !== uploadSequence || controller !== uploadController) return;
		if (!saved) throw new TypeError("当前浏览器不支持 IndexedDB，R2 暂存身份无法安全保存。");
		if (localRecordId && localRecordId !== record.localId) {
			await removeLocalStagedAsset(key, localRecordId).catch(() => undefined);
		}
		stagedAsset = asset;
		localRecordId = record.localId;
		locallyStaged = false;
		localStageMessage = "";
		onstaged();
		if (file.type === "application/pdf") close();
	} catch (error) {
		if (sequence !== uploadSequence || controller !== uploadController) return;
		if (!isAbortError(error)) {
			if (isR2StagingUnavailable(error)) {
				const key = localMediaKey();
				try {
					if (!key) throw new TypeError("当前文章缺少稳定的本地资源草稿身份。");
					const record = createLocalStagedAssetRecord({
						draftKey: key,
						file,
						...(localRecordId ? { localId: localRecordId } : {}),
						role: file.type.startsWith("image/") ? "inline" : "attachment",
					});
					const saved = await upsertLocalStagedAsset(record);
					if (sequence !== uploadSequence || controller !== uploadController) return;
					if (saved) {
						localRecordId = record.localId;
						locallyStaged = true;
						localStageMessage = `R2 暂时不可用，${selectedAssetLabel}已明确降级保存到此浏览器。该资源尚未上传到服务器，也不能提交文章；请稍后重新尝试 R2 上传。`;
						onstaged();
					} else {
						errorMessage = `R2 暂时不可用，且当前浏览器不支持 IndexedDB，本次${selectedAssetLabel}未暂存。`;
					}
				} catch {
					if (sequence !== uploadSequence || controller !== uploadController) return;
					errorMessage = `R2 暂时不可用，浏览器本地暂存也失败，本次${selectedAssetLabel}未保存。`;
				}
			} else {
				errorMessage =
					error instanceof Error ? error.message : `${selectedAssetLabel}暂存失败，请稍后重试。`;
			}
		}
	} finally {
		if (sequence === uploadSequence && controller === uploadController) {
			uploadController = undefined;
			uploading = false;
		}
	}
}

async function finishUploadedAsset(): Promise<void> {
	if (!stagedAsset || savingStagedAsset || uploading) return;
	errorMessage = "";
	savingStagedAsset = true;
	try {
		if (source === "attachment") {
			// 附件只进入草稿清单；普通 Markdown 链接统一由父编辑器列表生成，避免误走图片路径解析。
			close();
			return;
		}
		const derived = deriveStagedArticleAssetPath({
			assetId: stagedAsset.id,
			objectKey: stagedAsset.objectKey,
			originalFilename: stagedAsset.filename,
		});
		const src = parseArticleRelativeImagePath(derived.relativePath);
		oninsert(createMarkdownImage({ alt, src, title }));
		close();
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : "图片引用生成失败，请重新上传。";
	} finally {
		savingStagedAsset = false;
	}
}

function previewRemoteImage(): void {
	errorMessage = "";
	try {
		previewUrl = parseRemoteImageUrl(remoteUrl);
	} catch (error) {
		previewUrl = "";
		errorMessage = error instanceof Error ? error.message : "图片地址无效。";
	}
}

function selectRepositoryImage(entry: RepositoryEntry): void {
	const expectedPrefix = `${articleDirectory}/`;
	if (!storageSlug || !entry.path.startsWith(expectedPrefix)) {
		errorMessage = "当前编辑器仅允许把本文目录中的图片作为相对资源插入。";
		repositoryBrowserOpen = false;
		return;
	}
	const filename = entry.path.slice(expectedPrefix.length);
	try {
		repositoryPath = parseArticleRelativeImagePath(`./${filename}`);
		repositoryBrowserOpen = false;
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : "仓库图片路径无效。";
	}
}

function insertImage(): void {
	errorMessage = "";
	try {
		let src: string;
		if (source === "remote") {
			src = parseRemoteImageUrl(remoteUrl);
		} else if (source === "repository") {
			src = parseArticleRelativeImagePath(repositoryPath);
		} else {
			throw new TypeError("请先上传图片，再使用“暂存并插入”。");
		}
		oninsert(createMarkdownImage({ alt, src, title }));
		close();
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : "图片信息无效。";
	}
}

onDestroy(() => {
	resetUploadState();
	revokeUploadPreview();
});
</script>

{#if open}
	<div class="dialog-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && close()}>
		<section class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="image-dialog-title">
			<header>
				<div><p class="eyebrow">Insert image</p><h3 id="image-dialog-title">插入图片</h3></div>
				<button class="icon-button" type="button" aria-label="关闭" onclick={close}>×</button>
			</header>

			<div class="source-tabs" role="tablist" aria-label="资源来源">
				{#if capabilities.smallImageUpload}
					<button class:active={source === "upload"} type="button" onclick={() => selectSource("upload")}>上传图片</button>
				{/if}
				{#if capabilities.pdfAttachmentUpload}
					<button class:active={source === "attachment"} type="button" onclick={() => selectSource("attachment")}>上传附件</button>
				{/if}
				{#if capabilities.repositoryBrowser}
					<button class:active={source === "repository"} type="button" onclick={() => selectSource("repository")}>仓库图片</button>
				{/if}
				{#if capabilities.externalHttpsLinks}
					<button class:active={source === "remote"} type="button" onclick={() => selectSource("remote")}>图床链接</button>
				{/if}
			</div>

			{#if source === "upload" || source === "attachment"}
				<div class="upload-card">
					<label class="file-picker">
						选择{selectedAssetLabel}
						<input
							type="file"
							accept={isAttachmentSource ? "application/pdf,.pdf" : "image/jpeg,image/png,image/webp"}
							disabled={uploading || savingStagedAsset}
							onchange={selectUploadFile}
						/>
					</label>
					<p>{isAttachmentSource ? "当前仅支持 PDF；单个最大 4 MiB。ZIP 默认关闭。" : "支持 JPEG、PNG、WebP；单张最大 1 MiB，每篇最多 5 张且总量不超过 5 MiB。"}</p>
					<p class="field-note">{selectedAssetLabel}先暂存到当前文章草稿；只有保存文章成功后，才会与 index.md 一起出现在目标分支。</p>
					{#if uploadFile}
						<div class="upload-summary">
							<span>{uploadFile.name}</span>
							<span>{Math.max(1, Math.ceil(uploadFile.size / 1024))} KB</span>
						</div>
					{/if}
					{#if uploadPreviewUrl}
						<div class="remote-preview"><img src={uploadPreviewUrl} alt="本地图片预览" /></div>
					{/if}
					<button class="upload-button" type="button" disabled={!uploadFile || uploading || savingStagedAsset || !localMediaKey()} onclick={uploadToR2}>
						{uploading ? "正在上传…" : locallyStaged ? "重新尝试 R2 上传" : stagedAsset ? "重新上传" : "上传到 R2 暂存区"}
					</button>
					{#if locallyStaged}
						<p class="local-stage-warning" role="status">{localStageMessage}</p>
					{/if}
					{#if stagedAsset}
						<p class="upload-success" role="status">已安全暂存：{stagedAsset.objectKey}</p>
						<p class="field-note">
							{isAttachmentSource
								? "点击底部“完成附件暂存”后，可在编辑器的附件列表中插入安全的普通 Markdown 链接。"
								: "点击底部“暂存并插入”只会插入安全的 ./filename 引用；图片将在保存文章时参与同一次原子 Commit。"}
						</p>
					{/if}
				</div>
			{:else if source === "repository"}
				<div class="repository-actions">
					<button type="button" onclick={() => (repositoryBrowserOpen = true)}>浏览 GitHub 仓库</button>
					<span>默认打开 {articleDirectory}</span>
				</div>
				<label>本文目录图片路径<input bind:value={repositoryPath} placeholder="./cover.webp" /></label>
				<p class="field-note">可浏览完整仓库，但为了保证文章资源可移植，当前只能插入本文目录直接子文件。</p>
			{:else}
				<label>图床 HTTPS 地址<input bind:value={remoteUrl} type="url" placeholder="https://image.example.com/photo.webp" oninput={() => (previewUrl = "")} /></label>
				<button class="preview-button" type="button" onclick={previewRemoteImage}>验证并预览远程图片</button>
				{#if previewUrl}
					<div class="remote-preview"><img src={previewUrl} alt="远程图片预览" referrerpolicy="no-referrer" /></div>
				{/if}
			{/if}

			{#if source !== "attachment"}
				<div class="field-grid">
					<label>图片说明<input bind:value={alt} maxlength="300" placeholder="描述图片内容，便于无障碍访问" /></label>
					<label>悬停标题（可选）<input bind:value={title} maxlength="300" /></label>
				</div>
			{/if}

			{#if errorMessage}<p class="dialog-error" role="alert">{errorMessage}</p>{/if}
			<footer>
				<button class="secondary" type="button" onclick={close}>取消</button>
				{#if source === "upload" || source === "attachment"}
					<button type="button" disabled={!stagedAsset || uploading || savingStagedAsset} onclick={finishUploadedAsset}>
						{savingStagedAsset
							? source === "attachment"
								? "正在完成…"
								: "正在生成引用…"
							: source === "attachment"
								? "完成附件暂存"
								: "暂存并插入"}
					</button>
				{:else}
					<button type="button" disabled={uploading || savingStagedAsset} onclick={insertImage}>插入图片</button>
				{/if}
			</footer>
		</section>
	</div>
{/if}

{#if capabilities.repositoryBrowser}
	<RepositoryBrowser
		open={repositoryBrowserOpen}
		initialPath={articleDirectory}
		selectImagesOnly={true}
		onclose={() => (repositoryBrowserOpen = false)}
		onselect={selectRepositoryImage}
	/>
{/if}

<style>
	.dialog-backdrop { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 1rem; background: rgba(15, 23, 42, 0.36); backdrop-filter: blur(3px); }
	.dialog-card { width: min(620px, 100%); max-height: min(720px, calc(100vh - 2rem)); overflow: auto; padding: 1.1rem; border: 1px solid var(--border); border-radius: 1rem; background: white; box-shadow: 0 24px 80px rgba(15, 23, 42, 0.22); }
	header, footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	header h3 { margin: 0.15rem 0 0; font-size: 1.2rem; }
	.eyebrow { margin: 0; color: var(--brand-strong); font-size: 0.66rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
	.icon-button { width: 2rem; height: 2rem; border: 0; border-radius: 999px; background: var(--surface-subtle); color: var(--text-secondary); font-size: 1.3rem; cursor: pointer; }
	.source-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.25rem; margin: 1rem 0; padding: 0.25rem; border-radius: 0.7rem; background: var(--surface-subtle); }
	.source-tabs button { padding: 0.55rem; border: 0; border-radius: 0.5rem; background: transparent; color: var(--text-secondary); font: inherit; font-size: 0.78rem; font-weight: 750; cursor: pointer; }
	.source-tabs button.active { background: white; color: var(--brand-strong); box-shadow: var(--shadow-sm); }
	label { display: grid; gap: 0.38rem; margin-bottom: 0.8rem; color: var(--text-secondary); font-size: 0.76rem; font-weight: 750; }
	input { width: 100%; padding: 0.7rem 0.75rem; border: 1px solid var(--border); border-radius: 0.65rem; background: white; color: var(--text-primary); font: inherit; }
	input:focus { border-color: var(--brand); outline: 3px solid var(--brand-soft); }
	.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; margin-top: 1rem; }
	.field-note, .upload-card p { margin: -0.35rem 0 1rem; color: var(--text-muted); font-size: 0.74rem; }
	.repository-actions { display: flex; align-items: center; justify-content: space-between; gap: 0.7rem; margin-bottom: 0.75rem; padding: 0.65rem; border: 1px solid var(--border); border-radius: 0.65rem; background: var(--surface-subtle); }
	.repository-actions button { padding: 0.5rem 0.65rem; border: 0; border-radius: 0.5rem; background: var(--brand); color: white; font: inherit; font-size: 0.74rem; font-weight: 750; cursor: pointer; }
	.repository-actions span { overflow: hidden; color: var(--text-muted); font-size: 0.68rem; text-overflow: ellipsis; white-space: nowrap; }
	.upload-card { display: grid; gap: 0.75rem; padding: 0.9rem; border: 1px dashed var(--border); border-radius: 0.75rem; background: var(--surface-subtle); }
	.upload-card p { margin: 0; }
	.file-picker { margin: 0; padding: 0.75rem; border: 1px solid var(--border); border-radius: 0.65rem; background: white; cursor: pointer; }
	.file-picker input { margin-top: 0.5rem; padding: 0; border: 0; }
	.upload-summary { display: flex; justify-content: space-between; gap: 0.75rem; color: var(--text-secondary); font-size: 0.74rem; }
	.upload-summary span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.upload-button { justify-self: start; padding: 0.55rem 0.7rem; border: 0; border-radius: 0.6rem; background: var(--brand); color: white; font: inherit; font-size: 0.75rem; font-weight: 750; cursor: pointer; }
	.upload-button:disabled, footer button:disabled { opacity: 0.55; cursor: not-allowed; }
	.upload-success { overflow-wrap: anywhere; color: #15803d !important; font-weight: 750; }
	.local-stage-warning { padding: 0.65rem; border: 1px solid #f59e0b; border-radius: 0.6rem; background: #fffbeb; color: #92400e !important; font-weight: 700; }
	.preview-button { margin: -0.25rem 0 0.75rem; padding: 0.55rem 0.7rem; border: 1px solid var(--border); border-radius: 0.6rem; background: white; color: var(--text-secondary); font: inherit; font-size: 0.75rem; font-weight: 750; cursor: pointer; }
	.remote-preview { display: grid; place-items: center; min-height: 120px; max-height: 240px; overflow: hidden; border: 1px solid var(--border); border-radius: 0.75rem; background: var(--surface-subtle); }
	.remote-preview img { display: block; max-width: 100%; max-height: 240px; object-fit: contain; }
	.dialog-error { margin: 0.5rem 0; color: #b91c1c; font-size: 0.78rem; }
	footer { justify-content: flex-end; margin-top: 1rem; }
	footer button { padding: 0.65rem 0.9rem; border: 0; border-radius: 0.65rem; background: var(--brand); color: white; font: inherit; font-weight: 750; cursor: pointer; }
	footer button.secondary { border: 1px solid var(--border); background: white; color: var(--text-secondary); }
	@media (max-width: 560px) { .field-grid { grid-template-columns: 1fr; gap: 0; } .source-tabs { grid-template-columns: 1fr; } }
</style>
