<script lang="ts">
import { onDestroy, onMount } from "svelte";
import {
	ARTICLE_ASSET_MAX_COUNT,
	type ArticleAssetRole,
	deriveStagedArticleAssetPath,
} from "../../modules/media/media-config";
import type { AdminCapabilitySnapshot } from "../../types/capability";
import { parseMarkdownDocument } from "../../utils/frontmatter-utils";
import ArticleAssetPanel from "./ArticleAssetPanel.svelte";
import {
	clearArticleCoverReference,
	createRepositoryCoverCandidates,
	parseArticleCoverReference,
	replaceArticleCoverReference,
} from "./article-cover-state";
import {
	type ArticleDraftRecord,
	clearArticleMediaDraftId,
	createArticleDraftKey,
	createArticleDraftRecord,
	deleteArticleDraft,
	getOrCreateArticleMediaDraftId,
	loadArticleDraft,
	restoreArticleDraftForm,
	saveArticleDraft,
} from "./article-draft-store";
import {
	type ArticleEditorForm,
	type ArticleSlugAvailability,
	buildArticleWriteRequest,
	createEmptyArticleForm,
	createIdempotencyKey,
	formFromImportedMarkdown,
	formFromRemoteArticle,
	isValidStorageSlug,
	parseArticleCommitPayload,
	parseArticleDeletePayload,
	parseArticleDetailPayload,
	parseEditorApiError,
	parseRepositoryHeadSha,
	parseSlugAvailabilityStatus,
	type RemoteArticleData,
	suggestStorageSlug,
} from "./article-editor-state";
import {
	createArticleResourceChangesPayload,
	type PendingArticleResourceChange,
} from "./article-resource-state";
import CodeMirrorEditor from "./CodeMirrorEditor.svelte";
import type { CodeMirrorEditorHandle } from "./codemirror-runtime";
import EditorToolbar from "./EditorToolbar.svelte";
import MilkdownEditor from "../../modules/editor-core/adapters/milkdown/MilkdownEditor.svelte";
import type { MilkdownEditorHandle } from "../../modules/editor-core/adapters/milkdown/MilkdownEditor.svelte";
import {
	type BlockMarkdownCommand,
	createBlockMarkdownReplacement,
	createInlineMarkdownReplacement,
	createMarkdownImage,
	createMarkdownLink,
	type HeadingMarkdownCommand,
	type InlineMarkdownCommand,
} from "./editor-commands";
import ImageDialog from "./ImageDialog.svelte";
import LinkDialog from "./LinkDialog.svelte";
import MarkdownPreview from "./MarkdownPreview.svelte";
import {
	clearCommittedLocalStagedAssets,
	createLocalMediaDraftKey,
	createLocalStagedArticleAssetManifest,
	type LocalStagedAssetRecord,
	listLocalStagedAssets,
	removeLocalStagedAsset,
	upsertLocalStagedAsset,
} from "./media-local-staging";
import { commitMediaTransaction, previewMediaTransaction } from "./media-transaction-client";
import {
	applyMediaTransactionCommitError,
	beginMediaTransactionCommit,
	createMediaTransactionCommitRequest,
	createMediaTransactionCommitState,
	createMediaTransactionUnknownRecovery,
	isMediaTransactionCommitEligible,
	isMediaTransactionCommitLocked,
	isMediaTransactionConfirmationExact,
	type MediaTransactionCommitState,
	type MediaTransactionPreviewData,
	mapMediaTransactionCommitError,
	markMediaTransactionCommitConsumed,
	markMediaTransactionCommitRefreshed,
	markMediaTransactionCommitRefreshFailed,
	parseMediaTransactionCommitPayload,
	parseMediaTransactionPreviewPayload,
	parseMediaTransactionUnknownRecovery,
} from "./media-transaction-preview-state";
import {
	createMarkdownVideoSource,
	type MarkdownVideoProvider,
} from "../../modules/markdown-codec/video";

interface Props {
	mode: "create" | "edit";
	storageSlug?: string;
	capabilities: AdminCapabilitySnapshot;
}

let { mode, storageSlug, capabilities }: Props = $props();
let form = $state<ArticleEditorForm>(createEmptyArticleForm());
let expectedSha = $state("");
let expectedHeadSha = $state("");
let loading = $state(mode === "edit");
let saving = $state(false);
let deleting = $state(false);
let errorMessage = $state("");
let successMessage = $state("");
let dirty = $state(false);
let ready = $state(mode === "create");
let markdownView = $state<"visual" | "write" | "preview" | "split">("visual");
let draftCandidate = $state<ArticleDraftRecord | null>(null);
let draftMessage = $state("");
let draftStorageAvailable = $state(true);
let draftInitialized = $state(false);
let slugAvailability = $state<ArticleSlugAvailability>(mode === "edit" ? "occupied" : "invalid");
let slugAvailabilityMessage = $state("");
let lastCommitUrl = $state("");
let expectedArticleUrl = $state("");
let pendingPayload = "";
let pendingIdempotencyKey = "";
let pendingDeletePayload = "";
let pendingDeleteIdempotencyKey = "";
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let slugCheckTimer: ReturnType<typeof setTimeout> | undefined;
let slugCheckSequence = 0;
let importInput: HTMLInputElement | undefined;
let lastDraftSignature = "";
let lastSuggestedSlug = "";
let storageSlugManuallyEdited = false;
let codeMirrorHandle = $state<CodeMirrorEditorHandle | undefined>();
let milkdownHandle = $state<MilkdownEditorHandle | undefined>();
let visualEditorReady = $state(false);
let visualEditorFailed = $state(false);
let visualEditorGeneration = $state(0);
let imageDialogOpen = $state(false);
let linkDialogOpen = $state(false);
let specialBlockOpen = $state(false);
let pendingSpecialInsertion = $state("");
let specialVideoConfigOpen = $state(false);
let specialVideoProvider = $state<Exclude<MarkdownVideoProvider, "unknown">>("youtube");
let specialVideoId = $state("dQw4w9WgXcQ");
let specialBlockError = $state("");
let savedDialogSelection = $state({ from: 0, to: 0, text: "" });
let mediaDraftId = "";
let mediaDraftKey = $state("");
let stagedAssets = $state<LocalStagedAssetRecord[]>([]);
let mediaPreviewUrls = $state<Record<string, string>>({});
let mediaStorageAvailable = $state(true);
let mediaMessage = $state("");
let removingMediaId = $state("");
let updatingMediaId = $state("");
let repositoryResources = $state<RemoteArticleData["resources"]>([]);
let resourceReferenceAnalysis = $state<RemoteArticleData["resourceReferenceAnalysis"]>({
	complete: true,
	issues: [],
});
let resourceChanges = $state<PendingArticleResourceChange[]>([]);
let resourceMessage = $state("");
let resourcePreview = $state<MediaTransactionPreviewData | null>(null);
let mediaCommitState = $state<MediaTransactionCommitState>(createMediaTransactionCommitState());
let mediaCommitPhrase = $state("");
let mediaCommitMessage = $state("");
let mediaCommitRefreshing = $state(false);
let previewingResourceFilename = $state("");
let coverSource = $state<"repository" | "remote">("repository");
let coverRemoteUrl = $state("");
let coverMessage = $state("");

const draftKey = createArticleDraftKey(mode, storageSlug);
const mediaUnknownRecoveryKey =
	mode === "edit" && storageSlug ? `media-transaction-unknown:${storageSlug}` : "";
const repositoryCoverCandidates = $derived(
	createRepositoryCoverCandidates(
		repositoryResources.filter(
			(resource) =>
				!resourceChanges.some(
					(change) =>
						change.filename === resource.filename &&
						(change.operation === "delete" || change.operation === "move"),
				),
		),
	),
);
const mediaCommitLocked = $derived(isMediaTransactionCommitLocked(mediaCommitState.status));
const mediaCommitEligible = $derived(
	isMediaTransactionCommitEligible({
		mode,
		preview: resourcePreview,
		now: Date.now(),
		expectedHeadSha,
		expectedArticleSha: expectedSha,
		dirty,
		stagedAssetCount: stagedAssets.length,
		resourceChangeCount: resourceChanges.length,
		saving,
		status: mediaCommitState.status,
	}),
);
const mediaConfirmationValid = $derived(
	resourcePreview !== null &&
		isMediaTransactionConfirmationExact(resourcePreview, mediaCommitPhrase),
);

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function loadArticle(options: { mediaCommitRefresh?: boolean } = {}): Promise<boolean> {
	if (mode !== "edit" || !storageSlug) return false;
	if (!options.mediaCommitRefresh) {
		loading = true;
		errorMessage = "";
	}
	try {
		const response = await fetch(`/api/articles/${encodeURIComponent(storageSlug)}`, {
			headers: { Accept: "application/json" },
		});
		const body = await readJson(response);
		if (!response.ok) throw new Error(parseEditorApiError(body, response.status));
		const article = parseArticleDetailPayload(body);
		form = formFromRemoteArticle(article);
		visualEditorGeneration += 1;
		expectedSha = article.sha;
		expectedHeadSha = article.headSha;
		repositoryResources = article.resources ?? [];
		resourceReferenceAnalysis = article.resourceReferenceAnalysis ?? { complete: true, issues: [] };
		resourceChanges = [];
		resourceMessage = "";
		if (!options.mediaCommitRefresh) {
			resourcePreview = null;
			previewingResourceFilename = "";
		}
		dirty = false;
		ready = true;
		if (!options.mediaCommitRefresh) restoreUnknownMediaTransactionRecovery();
		await initializeDraftRecovery();
		return true;
	} catch (error) {
		if (!options.mediaCommitRefresh) {
			errorMessage = error instanceof Error ? error.message : "文章暂时无法加载。";
			ready = false;
		}
		return false;
	} finally {
		if (!options.mediaCommitRefresh) loading = false;
	}
}

async function initializeMediaDraft(): Promise<void> {
	if (!capabilities.smallImageUpload && !capabilities.pdfAttachmentUpload) return;
	try {
		if (mode === "create") {
			mediaDraftId = getOrCreateArticleMediaDraftId();
			mediaDraftKey = createLocalMediaDraftKey("create", mediaDraftId);
		} else if (storageSlug) {
			mediaDraftKey = createLocalMediaDraftKey("edit", storageSlug);
		}
		await refreshStagedAssets();
	} catch (error) {
		mediaStorageAvailable = false;
		mediaMessage = error instanceof Error ? error.message : "本地资源暂存区不可用。";
	}
}

function revokeMediaPreviewUrls(): void {
	for (const url of Object.values(mediaPreviewUrls)) URL.revokeObjectURL(url);
	mediaPreviewUrls = {};
}

function replaceStagedAssets(records: LocalStagedAssetRecord[]): void {
	revokeMediaPreviewUrls();
	stagedAssets = records;
	mediaPreviewUrls = Object.fromEntries(
		records
			.filter((record) => record.contentType.startsWith("image/"))
			.map((record) => [record.localId, URL.createObjectURL(record.blob)]),
	);
}

async function refreshStagedAssets(): Promise<void> {
	if (!mediaDraftKey) return;
	try {
		const listed = await listLocalStagedAssets(mediaDraftKey);
		if (!listed) {
			mediaStorageAvailable = false;
			mediaMessage = "当前浏览器不支持 IndexedDB，不能安全暂存文章资源。";
			replaceStagedAssets([]);
			return;
		}
		mediaStorageAvailable = true;
		replaceStagedAssets(listed.records);
		const localOnlyCount = stagedAssets.filter((record) => !record.r2).length;
		mediaMessage =
			stagedAssets.length === 0
				? ""
				: localOnlyCount > 0
					? `当前草稿有 ${localOnlyCount} 个资源尚未上传到 R2，提交前必须重试上传。`
					: `当前草稿有 ${stagedAssets.length} 个资源，将与文章一起原子提交。`;
	} catch (error) {
		mediaStorageAvailable = false;
		mediaMessage = error instanceof Error ? error.message : "读取本地资源暂存区失败。";
	}
}

async function initializeDraftRecovery(): Promise<void> {
	if (draftInitialized || !ready) return;
	draftInitialized = true;
	try {
		draftCandidate = await loadArticleDraft(draftKey);
		if (draftCandidate) {
			draftMessage = `发现 ${new Date(draftCandidate.savedAt).toLocaleString()} 自动保存的本地草稿。`;
		}
	} catch {
		draftStorageAvailable = false;
		draftMessage = "本地草稿存储不可用；你仍可正常提交到内容仓库。";
	}
}

async function restoreDraft(): Promise<void> {
	if (!draftCandidate) return;
	const restored = restoreArticleDraftForm(form, draftCandidate);
	try {
		const coverReference = parseArticleCoverReference(restored.image);
		await demoteUnselectedStagedCovers(coverReference);
		form = restored;
		visualEditorGeneration += 1;
		// expectedSha 始终保留本次远端加载得到的版本，不能信任 IndexedDB 中的旧 SHA。
		dirty = true;
		draftCandidate = null;
		draftMessage = "已恢复本地草稿，提交前仍会使用当前远端版本执行乐观锁校验。";
		lastDraftSignature = "";
		scheduleDraftSave();
	} catch (error) {
		draftMessage = error instanceof Error ? error.message : "恢复本地草稿失败。";
	}
}

async function discardDraft(): Promise<void> {
	try {
		await deleteArticleDraft(draftKey);
	} catch {
		draftStorageAvailable = false;
	}
	draftCandidate = null;
	draftMessage = draftStorageAvailable
		? "已放弃本地草稿。"
		: "无法清理本地草稿，但不会自动恢复它。";
}

function scheduleDraftSave(): void {
	if (!draftInitialized || !draftStorageAvailable || !dirty || draftCandidate) return;
	if (draftTimer !== undefined) clearTimeout(draftTimer);
	draftTimer = setTimeout(() => void persistDraft(), 800);
}

async function persistDraft(): Promise<void> {
	if (!draftStorageAvailable || !dirty || draftCandidate) return;
	const record = createArticleDraftRecord({
		key: draftKey,
		form,
		...(mode === "edit" && expectedSha ? { baseSha: expectedSha } : {}),
	});
	const signature = JSON.stringify(record.form);
	if (signature === lastDraftSignature) return;

	try {
		const stored = await saveArticleDraft(record);
		if (!stored) {
			draftStorageAvailable = false;
			draftMessage = "当前浏览器不支持本地草稿；你仍可正常提交到内容仓库。";
			return;
		}
		lastDraftSignature = signature;
		draftMessage = `本地草稿已自动保存于 ${new Date(record.savedAt).toLocaleTimeString()}（不含访问密码和密码提示）。`;
	} catch {
		draftStorageAvailable = false;
		draftMessage = "本地草稿保存失败；你仍可正常提交到内容仓库。";
	}
}

function markDirty(): void {
	if (mediaCommitLocked) return;
	if (ready) {
		dirty = true;
		successMessage = "";
		scheduleDraftSave();
	}
}

function updateMarkdown(value: string): void {
	form.markdown = value;
	markDirty();
}

function handleVisualEditorError(message: string): void {
	visualEditorFailed = true;
	visualEditorReady = false;
	errorMessage = `画布初始化失败：${message}`;
}

function retryVisualEditor(): void {
	visualEditorFailed = false;
	errorMessage = "";
	visualEditorGeneration += 1;
}

function openSourceFromCanvas(): void {
	markdownView = "write";
	requestAnimationFrame(() => codeMirrorHandle?.focus());
}

function getEditorSelection() {
	if (markdownView === "visual" && milkdownHandle) return milkdownHandle.getSelection();
	return codeMirrorHandle?.getSelection() ?? { from: 0, to: 0, text: "" };
}

function applyInlineCommand(command: InlineMarkdownCommand): void {
	if (markdownView === "visual") {
		milkdownHandle?.runCommand(command);
		return;
	}
	const replacement = createInlineMarkdownReplacement(command, getEditorSelection());
	codeMirrorHandle?.replaceSelection(
		replacement.text,
		replacement.selectionFrom,
		replacement.selectionTo,
	);
}

function applyBlockCommand(command: BlockMarkdownCommand): void {
	if (markdownView === "visual") {
		milkdownHandle?.runCommand(command);
		return;
	}
	const replacement = createBlockMarkdownReplacement(command, getEditorSelection());
	codeMirrorHandle?.replaceSelection(
		replacement.text,
		replacement.selectionFrom,
		replacement.selectionTo,
	);
}

function applyHeadingCommand(command: "paragraph" | HeadingMarkdownCommand): void {
	if (markdownView === "visual") {
		milkdownHandle?.runCommand(command);
		return;
	}
	const replacement = createBlockMarkdownReplacement(command, getEditorSelection());
	codeMirrorHandle?.replaceSelection(
		replacement.text,
		replacement.selectionFrom,
		replacement.selectionTo,
	);
}

function undoEditor(): void {
	if (markdownView === "visual") milkdownHandle?.undo();
	else codeMirrorHandle?.undo();
}

function redoEditor(): void {
	if (markdownView === "visual") milkdownHandle?.redo();
	else codeMirrorHandle?.redo();
}

type SpecialBlockKind = "callout" | "details" | "math" | "mermaid" | "video";

const SPECIAL_BLOCK_LABELS: Record<SpecialBlockKind, { title: string; hint: string }> = {
	callout: { title: "提示框", hint: "Firefly GitHub Callout，占位显示，不渲染" },
	details: { title: "折叠内容", hint: "受控 Details 子集，占位显示，不展开执行" },
	math: { title: "数学公式", hint: "块级公式，占位显示，不加载 KaTeX" },
	mermaid: { title: "Mermaid", hint: "Mermaid 代码块，占位显示，不生成 SVG" },
	video: { title: "视频", hint: "YouTube / B 站固定源码，占位显示，不加载播放器" },
};

function createSpecialBlockSource(kind: SpecialBlockKind): string {
	switch (kind) {
		case "callout":
			return "> [!NOTE] 兼容原则\n> 特殊语法保留原始源码。\n";
		case "details":
			return "<details>\n<summary>查看兼容策略</summary>\n\n内容保持原始源码。\n</details>\n";
		case "math":
			return "$$\nE = mc^2\n$$\n";
		case "mermaid":
			return "```mermaid\nflowchart LR\n    A[Markdown] --> B[源码占位]\n```\n";
		case "video":
			return createMarkdownVideoSource(specialVideoProvider, specialVideoId.trim());
	}
}

function openSpecialBlockDialog(): void {
	specialBlockError = "";
	specialVideoConfigOpen = false;
	specialBlockOpen = true;
}

function selectSpecialBlock(kind: SpecialBlockKind): void {
	if (kind === "video") {
		specialBlockError = "";
		specialVideoConfigOpen = true;
		return;
	}
	insertSpecialBlock(kind);
}

function insertSpecialBlock(kind: SpecialBlockKind): void {
	specialBlockError = "";
	if (kind === "video") {
		const normalizedId = specialVideoId.trim();
		const valid =
			specialVideoProvider === "youtube"
				? /^[A-Za-z0-9_-]{11}$/.test(normalizedId)
				: /^BV[A-Za-z0-9]{10}$/.test(normalizedId);
		if (!valid) {
			specialBlockError =
				specialVideoProvider === "youtube"
					? "请输入 11 位 YouTube 视频 ID。"
					: "请输入 BV 加 10 位字符的 B 站视频号。";
			return;
		}
	}
	const source = createSpecialBlockSource(kind);
	specialBlockOpen = false;
	const separator = form.markdown.endsWith("\n") ? "\n" : "\n\n";
	pendingSpecialInsertion = `${separator}${source}`;
	markdownView = "write";
	if (codeMirrorHandle) insertPendingSpecialBlock(codeMirrorHandle);
}

function insertPendingSpecialBlock(handle: CodeMirrorEditorHandle): void {
	if (!pendingSpecialInsertion) return;
	const insertion = pendingSpecialInsertion;
	pendingSpecialInsertion = "";
	handle.replaceRange(
		insertion,
		form.markdown.length,
		form.markdown.length,
		insertion.length,
		insertion.length,
	);
}

function openImageDialog(): void {
	savedDialogSelection = getEditorSelection();
	imageDialogOpen = true;
}

function openLinkDialog(): void {
	savedDialogSelection = getEditorSelection();
	linkDialogOpen = true;
}

function insertDialogMarkdown(markdown: string): void {
	if (markdownView === "visual") {
		milkdownHandle?.replaceMarkdown(markdown, savedDialogSelection.from, savedDialogSelection.to);
		return;
	}
	codeMirrorHandle?.replaceRange(
		markdown,
		savedDialogSelection.from,
		savedDialogSelection.to,
		markdown.length,
		markdown.length,
	);
}

function insertStagedAsset(record: LocalStagedAssetRecord): void {
	if (mediaCommitLocked) return;
	const isImage = record.contentType.startsWith("image/");
	if (!record.r2) {
		mediaMessage = `该${isImage ? "图片" : "附件"}尚未上传到 R2，不能生成最终文章引用。`;
		return;
	}
	try {
		const { relativePath } = deriveStagedArticleAssetPath({
			assetId: record.r2.assetId,
			objectKey: record.r2.objectKey,
			originalFilename: record.filename,
		});
		const markdown = isImage
			? createMarkdownImage({ alt: record.filename, src: relativePath })
			: createMarkdownLink({ text: record.filename, href: relativePath });
		const selection = getEditorSelection();
		if (markdownView === "visual") {
			milkdownHandle?.replaceMarkdown(markdown, selection.from, selection.to);
			mediaMessage = `已插入 ${record.filename} 的安全相对${isImage ? "图片引用" : "附件链接"}。`;
			return;
		}
		codeMirrorHandle?.replaceRange(
			markdown,
			selection.from,
			selection.to,
			markdown.length,
			markdown.length,
		);
		mediaMessage = `已插入 ${record.filename} 的安全相对${isImage ? "图片引用" : "附件链接"}。`;
	} catch (error) {
		mediaMessage = error instanceof Error ? error.message : "资源引用生成失败。";
	}
}

function getStagedAssetRelativePath(record: LocalStagedAssetRecord): string | undefined {
	if (!record.r2) return undefined;
	return deriveStagedArticleAssetPath({
		assetId: record.r2.assetId,
		objectKey: record.r2.objectKey,
		originalFilename: record.filename,
	}).relativePath;
}

async function demoteUnselectedStagedCovers(selectedReference: string): Promise<void> {
	const covers = stagedAssets.filter(
		(record) => record.role === "cover" && getStagedAssetRelativePath(record) !== selectedReference,
	);
	for (const record of covers) await upsertLocalStagedAsset({ ...record, role: "inline" });
	if (covers.length > 0) await refreshStagedAssets();
}

async function applyCoverReference(next: unknown, message: string): Promise<void> {
	if (mediaCommitLocked || updatingMediaId || removingMediaId) return;
	try {
		const result = replaceArticleCoverReference(form.image, next);
		await demoteUnselectedStagedCovers(result.value);
		form.image = result.value;
		coverRemoteUrl = result.value.startsWith("https://") ? result.value : "";
		coverMessage = result.changed ? message : "当前封面引用未发生变化。";
		if (result.changed) markDirty();
	} catch (error) {
		coverMessage = error instanceof Error ? error.message : "封面地址无效。";
	}
}

async function chooseRepositoryCover(reference: string): Promise<void> {
	await applyCoverReference(reference, `已选择 ${reference} 作为封面；不会修改或删除仓库文件。`);
}

async function applyRemoteCover(): Promise<void> {
	await applyCoverReference(
		coverRemoteUrl,
		"已设置受控 HTTPS 外部封面。保存文章后才会写入 Frontmatter。",
	);
}

async function clearCover(): Promise<void> {
	if (mediaCommitLocked) return;
	const result = clearArticleCoverReference(form.image);
	try {
		await demoteUnselectedStagedCovers("");
		form.image = result.value;
		coverRemoteUrl = "";
		coverMessage = result.changed
			? "已移除封面引用；草稿资源和仓库文件均未删除。"
			: "当前没有可移除的封面引用。";
		if (result.changed) markDirty();
	} catch (error) {
		coverMessage = error instanceof Error ? error.message : "移除封面引用失败。";
	}
}

async function handleCoverInput(): Promise<void> {
	if (mediaCommitLocked) return;
	coverMessage = "";
	try {
		const normalized = parseArticleCoverReference(form.image);
		await demoteUnselectedStagedCovers(normalized);
		if (normalized !== form.image.trim()) form.image = normalized;
	} catch (error) {
		coverMessage = error instanceof Error ? error.message : "封面地址无效。";
	}
}

async function updateStagedImageRole(
	record: LocalStagedAssetRecord,
	role: ArticleAssetRole,
): Promise<void> {
	if (
		mediaCommitLocked ||
		!mediaDraftKey ||
		updatingMediaId ||
		removingMediaId ||
		record.role === role
	) {
		return;
	}
	if (role === "cover" && !record.r2) {
		mediaMessage = "图片尚未上传到 R2，不能设为封面。";
		return;
	}
	updatingMediaId = record.localId;
	let formChanged = false;
	try {
		const previousRelativePath = getStagedAssetRelativePath(record);
		if (role === "cover") {
			for (const previousCover of stagedAssets.filter(
				(entry) => entry.role === "cover" && entry.localId !== record.localId,
			)) {
				await upsertLocalStagedAsset({ ...previousCover, role: "inline" });
				const oldCoverPath = getStagedAssetRelativePath(previousCover);
				if (oldCoverPath && form.image === oldCoverPath) {
					form.image = "";
					formChanged = true;
				}
			}
		}
		await upsertLocalStagedAsset({ ...record, role });
		await refreshStagedAssets();
		if (role === "cover") {
			const nextRecord = stagedAssets.find((entry) => entry.localId === record.localId);
			const relativePath = nextRecord ? getStagedAssetRelativePath(nextRecord) : undefined;
			if (!relativePath) throw new TypeError("封面图片尚未上传到 R2，不能写入 Frontmatter。");
			form.image = relativePath;
			formChanged = true;
			mediaMessage = `已将 ${record.filename} 设为唯一封面。`;
		} else {
			if (previousRelativePath && form.image === previousRelativePath) {
				form.image = "";
				formChanged = true;
			}
			mediaMessage = `已将 ${record.filename} 设为正文图片。`;
		}
		markDirty();
	} catch (error) {
		await refreshStagedAssets();
		if (formChanged) markDirty();
		mediaMessage = error instanceof Error ? error.message : "更新图片用途失败。";
	} finally {
		updatingMediaId = "";
	}
}

async function removeStagedAsset(record: LocalStagedAssetRecord): Promise<void> {
	if (mediaCommitLocked || !mediaDraftKey || removingMediaId || updatingMediaId) return;
	if (
		!window.confirm(
			`移除 ${record.filename} 的待提交资源？正文中已插入的引用不会自动删除，需要你自行检查。`,
		)
	) {
		return;
	}
	removingMediaId = record.localId;
	try {
		const relativePath = getStagedAssetRelativePath(record);
		await removeLocalStagedAsset(mediaDraftKey, record.localId);
		await refreshStagedAssets();
		if (relativePath && form.image === relativePath) {
			form.image = "";
			markDirty();
		}
		mediaMessage = `已从当前草稿移除 ${record.filename}；请检查正文中的相关引用。`;
	} catch (error) {
		mediaMessage = error instanceof Error ? error.message : "移除本地暂存资源失败。";
	} finally {
		removingMediaId = "";
	}
}

function updateTitle(): void {
	if (mode !== "create") return;
	const suggestion = suggestStorageSlug(form.title);
	if (!storageSlugManuallyEdited || form.storageSlug === lastSuggestedSlug) {
		form.storageSlug = suggestion;
		lastSuggestedSlug = suggestion;
		scheduleSlugCheck();
	}
}

function handleStorageSlugInput(): void {
	storageSlugManuallyEdited = form.storageSlug !== lastSuggestedSlug;
	scheduleSlugCheck();
}

function scheduleSlugCheck(): void {
	if (mode !== "create") return;
	if (slugCheckTimer !== undefined) clearTimeout(slugCheckTimer);
	// HEAD 只对完成预检时的目标路径有效；slug 一变就必须立即作废，不能复用旧路径基线。
	expectedHeadSha = "";
	const sequence = ++slugCheckSequence;
	const slug = form.storageSlug.trim();
	if (!isValidStorageSlug(slug)) {
		slugAvailability = "invalid";
		slugAvailabilityMessage = slug.length === 0 ? "" : "slug 格式无效。";
		return;
	}
	slugAvailability = "checking";
	slugAvailabilityMessage = "正在检查远端仓库…";
	slugCheckTimer = setTimeout(() => void checkSlugAvailability(slug, sequence), 500);
}

async function checkSlugAvailability(slug: string, sequence: number): Promise<void> {
	try {
		const response = await fetch(`/api/articles/${encodeURIComponent(slug)}`, { method: "HEAD" });
		if (sequence !== slugCheckSequence || slug !== form.storageSlug.trim()) return;
		slugAvailability = parseSlugAvailabilityStatus(response.status);
		expectedHeadSha =
			slugAvailability === "available" || slugAvailability === "occupied"
				? parseRepositoryHeadSha(response.headers.get("X-Repository-Head-Sha"))
				: "";
		slugAvailabilityMessage =
			slugAvailability === "available"
				? "该 storage slug 当前可用。"
				: slugAvailability === "occupied"
					? "该 storage slug 已被远端文章占用。"
					: "暂时无法确认 slug 是否可用；提交时仍会由仓库原子校验。";
	} catch {
		if (sequence !== slugCheckSequence || slug !== form.storageSlug.trim()) return;
		expectedHeadSha = "";
		slugAvailability = "unknown";
		slugAvailabilityMessage = "暂时无法确认 slug 是否可用；请检查网络后重试。";
	}
}

async function importMarkdownFile(event: Event): Promise<void> {
	if (mediaCommitLocked) return;
	const input = event.currentTarget;
	if (!(input instanceof HTMLInputElement)) return;
	const file = input.files?.[0];
	input.value = "";
	if (!file) return;

	errorMessage = "";
	successMessage = "";
	if (!file.name.toLowerCase().endsWith(".md")) {
		errorMessage = "只能导入 .md Markdown 文件。";
		return;
	}
	if (file.size === 0 || file.size > 1_064_000) {
		errorMessage = "Markdown 文件必须非空且不超过约 1 MB。";
		return;
	}
	if (dirty && !window.confirm("导入会覆盖当前表单和正文中的未保存修改，是否继续？")) return;

	try {
		// 先完整读取、解析和映射，全部成功后才替换响应式表单，避免半导入状态。
		const source = await file.text();
		const document = parseMarkdownDocument(source);
		const imported = formFromImportedMarkdown(form, document);
		const coverReference = parseArticleCoverReference(imported.image);
		await demoteUnselectedStagedCovers(coverReference);
		form = imported;
		visualEditorGeneration += 1;
		dirty = true;
		pendingPayload = "";
		pendingIdempotencyKey = "";
		successMessage = `已导入 ${file.name}；存储 slug 保持不变，尚未提交到内容仓库。`;
		scheduleDraftSave();
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : "Markdown 文件导入失败。";
	}
}

function persistUnknownMediaTransaction(): void {
	if (!mediaUnknownRecoveryKey || !storageSlug || !resourcePreview) return;
	if (mediaCommitState.status !== "unknown") {
		sessionStorage.removeItem(mediaUnknownRecoveryKey);
		return;
	}
	const recovery = createMediaTransactionUnknownRecovery(
		storageSlug,
		resourcePreview,
		mediaCommitState,
	);
	sessionStorage.setItem(mediaUnknownRecoveryKey, JSON.stringify(recovery));
}

function clearUnknownMediaTransactionRecovery(): void {
	if (mediaUnknownRecoveryKey) sessionStorage.removeItem(mediaUnknownRecoveryKey);
}

function restoreUnknownMediaTransactionRecovery(): boolean {
	if (!capabilities.articleAssetRename || !mediaUnknownRecoveryKey || !storageSlug) return false;
	const stored = sessionStorage.getItem(mediaUnknownRecoveryKey);
	if (!stored) return false;
	try {
		const recovery = parseMediaTransactionUnknownRecovery(JSON.parse(stored), storageSlug);
		resourcePreview = recovery.preview;
		mediaCommitState = recovery.state;
		mediaCommitPhrase =
			recovery.preview.confirmation.kind === "phrase" ? recovery.preview.confirmation.phrase : "";
		mediaCommitMessage =
			"已恢复待确认的媒体事务。页面版本可能已变化，只能使用原请求和原幂等键查询原结果。";
		return true;
	} catch {
		sessionStorage.removeItem(mediaUnknownRecoveryKey);
		return false;
	}
}

async function previewRepositoryRename(
	resource: NonNullable<RemoteArticleData["resources"]>[number],
): Promise<void> {
	if (!capabilities.articleAssetRename || mediaCommitLocked) return;
	const destinationFilename = window
		.prompt("输入同一文章目录内的新文件名：", resource.filename)
		?.trim();
	if (!destinationFilename || destinationFilename === resource.filename) return;
	previewingResourceFilename = resource.filename;
	resourcePreview = null;
	mediaCommitState = createMediaTransactionCommitState();
	clearUnknownMediaTransactionRecovery();
	mediaCommitPhrase = "";
	mediaCommitMessage = "";
	resourceMessage = "";
	try {
		const { response, body } = await previewMediaTransaction({
			version: 1,
			operation: "rename",
			storageSlug: resource.storageSlug,
			sourceFilename: resource.filename,
			destinationFilename,
			expectedHeadSha,
			expectedArticleSha: expectedSha,
			expectedBlobSha: resource.blobSha,
		});
		if (!response.ok) throw new Error(parseEditorApiError(body, response.status));
		resourcePreview = parseMediaTransactionPreviewPayload(body);
		mediaCommitState = createMediaTransactionCommitState(resourcePreview);
		resourceMessage = "影响预览已生成，请核对版本锁与确认要求后提交。";
	} catch (error) {
		resourceMessage = error instanceof Error ? error.message : "资源重命名预览失败。";
	} finally {
		previewingResourceFilename = "";
	}
}

function clearResourcePreview(): void {
	if (mediaCommitLocked) return;
	resourcePreview = null;
	mediaCommitState = createMediaTransactionCommitState();
	clearUnknownMediaTransactionRecovery();
	mediaCommitPhrase = "";
	mediaCommitMessage = "";
	resourceMessage = "";
}

async function commitResourceTransaction(): Promise<void> {
	if (!resourcePreview || !mediaCommitEligible || !mediaConfirmationValid) return;
	const request = createMediaTransactionCommitRequest(resourcePreview, mediaCommitPhrase);
	try {
		// 媒体事务与文章保存拥有独立幂等身份；发出后冻结 request/key，unknown 只能原样恢复。
		mediaCommitState = beginMediaTransactionCommit(mediaCommitState, request);
		imageDialogOpen = false;
		linkDialogOpen = false;
		mediaCommitMessage = "正在提交媒体事务…";
		const { response, body } = await commitMediaTransaction(
			request,
			mediaCommitState.attempt?.key ?? "",
		);
		if (!response.ok) {
			const mapped = mapMediaTransactionCommitError(body, response.status);
			mediaCommitState = applyMediaTransactionCommitError(mediaCommitState, mapped.kind);
			persistUnknownMediaTransaction();
			mediaCommitMessage = mapped.message;
			return;
		}
		const result = parseMediaTransactionCommitPayload(body);
		if (result.previewId !== resourcePreview.previewId) {
			throw new TypeError("Commit Result 与当前 Preview 不匹配。");
		}
		// 先持久化 consumed 结果和 URL，再刷新文章；刷新失败不得降级成 Commit 失败。
		mediaCommitState = markMediaTransactionCommitConsumed(mediaCommitState, result);
		clearUnknownMediaTransactionRecovery();
		mediaCommitMessage = "媒体事务已提交成功，正在刷新文章资源…";
		const refreshed = await loadArticle({ mediaCommitRefresh: true });
		if (!refreshed) {
			mediaCommitState = markMediaTransactionCommitRefreshFailed(mediaCommitState);
			mediaCommitMessage = "提交已成功，但刷新失败。请重新加载文章查看最新资源。";
			return;
		}
		mediaCommitState = { status: "consumed", attempt: null, result };
		mediaCommitPhrase = "";
		mediaCommitMessage =
			response.headers.get("Idempotency-Replayed") === "true"
				? "已确认此前的媒体事务提交结果。"
				: "媒体事务已提交成功，文章资源已刷新。";
	} catch (error) {
		if (mediaCommitState.status === "committing") {
			mediaCommitState = applyMediaTransactionCommitError(mediaCommitState, "unknown");
			persistUnknownMediaTransaction();
			mediaCommitMessage = "提交结果待确认，只能使用原幂等键重试，禁止生成新 Preview 或重新提交。";
			return;
		}
		mediaCommitMessage = error instanceof Error ? error.message : "媒体事务提交失败。";
	}
}

async function refreshArticleAfterMediaCommit(): Promise<void> {
	if (mediaCommitState.status !== "refresh-failed" || mediaCommitRefreshing) return;
	mediaCommitRefreshing = true;
	mediaCommitMessage = "正在重新加载文章资源…";
	try {
		if (!(await loadArticle({ mediaCommitRefresh: true }))) {
			mediaCommitMessage = "重新加载文章失败。提交已成功，仍禁止重提交，请再次重试加载。";
			return;
		}
		mediaCommitState = markMediaTransactionCommitRefreshed(mediaCommitState);
		mediaCommitPhrase = "";
		mediaCommitMessage = "文章资源已重新加载，可以继续编辑。";
	} finally {
		mediaCommitRefreshing = false;
	}
}

function getIdempotencyKey(payload: string): string {
	if (payload !== pendingPayload) {
		pendingPayload = payload;
		pendingIdempotencyKey = createIdempotencyKey();
	}
	return pendingIdempotencyKey;
}

async function deleteCurrentArticle(): Promise<void> {
	if (
		mode !== "edit" ||
		!storageSlug ||
		deleting ||
		saving ||
		mediaCommitLocked ||
		!expectedSha ||
		!expectedHeadSha
	) {
		return;
	}
	if (
		dirty ||
		stagedAssets.length > 0 ||
		resourceChanges.length > 0 ||
		mediaCommitState.status !== "idle"
	) {
		errorMessage = "存在未保存修改、暂存图片或未结束的资源事务，请先处理后再删除文章。";
		return;
	}
	if (
		!window.confirm(
			"删除后，其他文章中指向本文或标题段落的链接可能失效。系统不会扫描或自动修复全站链接。是否继续？",
		)
	) {
		return;
	}
	if (!window.confirm(`请再次确认：永久删除文章 /${storageSlug} 及可安全归属的小图？`)) {
		return;
	}
	errorMessage = "";
	successMessage = "";
	const payload = JSON.stringify({ expectedHeadSha, expectedSha });
	if (payload !== pendingDeletePayload) {
		pendingDeletePayload = payload;
		pendingDeleteIdempotencyKey = createIdempotencyKey();
	}
	deleting = true;
	try {
		const response = await fetch(`/api/articles/${encodeURIComponent(storageSlug)}`, {
			method: "DELETE",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"Idempotency-Key": pendingDeleteIdempotencyKey,
				"X-Firefly-Admin": "1",
			},
			body: payload,
		});
		const body = await readJson(response);
		if (!response.ok) throw new Error(parseEditorApiError(body, response.status));
		const deletion = parseArticleDeletePayload(body);
		try {
			await deleteArticleDraft(draftKey);
			if (mediaDraftKey) {
				const localAssets = await listLocalStagedAssets(mediaDraftKey);
				if (localAssets) {
					await clearCommittedLocalStagedAssets(
						mediaDraftKey,
						localAssets.records.map((record) => record.localId),
					);
				}
			}
		} catch {
			// 远端删除已经完成，本地缓存清理失败不能触发第二次 Git 删除。
		}
		sessionStorage.setItem("article-delete-result", JSON.stringify({ deletion }));
		window.location.assign("/articles");
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : "删除文章失败，请稍后重试。";
	} finally {
		deleting = false;
	}
}

async function saveArticle(event: SubmitEvent): Promise<void> {
	event.preventDefault();
	if (saving || mediaCommitLocked || !ready) return;
	const submitter = event.submitter;
	const action =
		submitter instanceof HTMLButtonElement && submitter.value === "publish" ? "publish" : "draft";
	if (
		action === "publish" &&
		!window.confirm("正式发布会提交到主分支并触发现有 Cloudflare 构建流程，是否继续？")
	) {
		return;
	}
	errorMessage = "";
	successMessage = "";

	try {
		if (markdownView === "visual" && milkdownHandle) {
			form.markdown = milkdownHandle.flush();
		}
		// 操作语义由服务端再次校验；不能只依赖表单中的 draft 复选框区分发布限流。
		const targetForm = { ...form, draft: action === "draft" };
		const writeRequest = buildArticleWriteRequest(targetForm);
		if (mode === "create" && slugAvailability === "occupied") {
			throw new TypeError("存储 slug 已被占用，请更换后再创建。");
		}
		if (mode === "create" && (slugAvailability !== "available" || !expectedHeadSha)) {
			throw new TypeError("请先完成当前存储 slug 的远端可用性检查。");
		}
		if (mode === "edit" && (!expectedSha || !expectedHeadSha)) {
			throw new TypeError("缺少文章或分支版本信息，请重新加载。");
		}
		if (!mediaDraftKey) {
			throw new TypeError("缺少稳定的本地资源草稿身份，请重新加载页面。");
		}
		const listedAssets = await listLocalStagedAssets(mediaDraftKey);
		if (!listedAssets) {
			mediaStorageAvailable = false;
			stagedAssets = [];
		} else {
			mediaStorageAvailable = true;
			stagedAssets = listedAssets.records;
		}
		const submittedAssets = [...stagedAssets];
		const assetManifest = createLocalStagedArticleAssetManifest(submittedAssets);
		const submittedResourceChanges = createArticleResourceChangesPayload(resourceChanges);
		const body =
			mode === "create"
				? { ...writeRequest, expectedHeadSha, action, assetManifest }
				: {
						expectedHeadSha,
						expectedSha,
						article: writeRequest.article,
						action,
						assetManifest,
						resourceChanges: submittedResourceChanges,
					};
		const payload = JSON.stringify(body);
		saving = true;
		const endpoint =
			mode === "create"
				? "/api/articles"
				: `/api/articles/${encodeURIComponent(writeRequest.storageSlug)}`;
		const response = await fetch(endpoint, {
			method: mode === "create" ? "POST" : "PUT",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"Idempotency-Key": getIdempotencyKey(payload),
				"X-Firefly-Admin": "1",
			},
			body: payload,
		});
		const responseBody = await readJson(response);
		if (!response.ok) throw new Error(parseEditorApiError(responseBody, response.status));
		const commit = parseArticleCommitPayload(responseBody);
		expectedSha = commit.fileSha;
		expectedHeadSha = commit.commitSha;
		lastCommitUrl = commit.commitUrl;
		expectedArticleUrl = commit.expectedArticleUrl ?? "";
		form.draft = action === "draft";
		if (mode === "edit" && submittedResourceChanges.changes.length > 0) {
			// Commit 已成功后重新读取下一次编辑所需的资源 Blob SHA；不能猜测移动或替换后的 SHA。
			await loadArticle();
		} else {
			resourceChanges = [];
			resourceMessage = "";
		}
		dirty = false;
		if (draftTimer !== undefined) clearTimeout(draftTimer);
		try {
			await deleteArticleDraft(draftKey);
			lastDraftSignature = "";
			draftCandidate = null;
			draftMessage = "本地草稿已在仓库提交成功后清除。";
		} catch {
			draftStorageAvailable = false;
			draftMessage = "文章已提交，但本地草稿清理失败；下次打开时请放弃旧草稿。";
		}
		try {
			await clearCommittedLocalStagedAssets(
				mediaDraftKey,
				submittedAssets.map((record) => record.localId),
			);
			// 清理后重新读取，保留请求飞行期间可能新增的记录，不能把它们从 UI 状态中误抹掉。
			await refreshStagedAssets();
			if (submittedAssets.length > 0 && stagedAssets.length === 0) {
				mediaMessage = "已清理本次提交的浏览器资源副本。";
			}
		} catch {
			mediaStorageAvailable = false;
			mediaMessage = "文章已提交，但本地资源副本清理失败；请勿重复上传相同资源。";
		}
		if (mode === "create" && mediaDraftId) clearArticleMediaDraftId(mediaDraftId);
		pendingPayload = "";
		pendingIdempotencyKey = "";
		successMessage =
			response.headers.get("Idempotency-Replayed") === "true"
				? `已确认此前的${action === "publish" ? "发布" : "草稿保存"}结果。`
				: action === "publish"
					? "文章已正式发布，现有 Cloudflare 流程将从主分支开始构建。"
					: "文章已保存为 GitHub 草稿。";
		if (mode === "create") {
			// 创建后会进入编辑路由；用会话存储跨越这次导航展示已验证的提交链接，读取后即删。
			sessionStorage.setItem(
				`article-commit:${commit.storageSlug}`,
				JSON.stringify({ article: commit }),
			);
			window.location.assign(`/articles/${commit.storageSlug}`);
		}
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : "保存文章失败，请稍后重试。";
	} finally {
		saving = false;
	}
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
	if (!dirty && stagedAssets.length === 0 && resourceChanges.length === 0 && !mediaCommitLocked) {
		return;
	}
	event.preventDefault();
	event.returnValue = "";
}

onMount(() => {
	if (capabilities.smallImageUpload || capabilities.pdfAttachmentUpload)
		void initializeMediaDraft();
	if (mode === "create") {
		void initializeDraftRecovery();
		return;
	}
	if (!storageSlug) return;
	if (capabilities.articleAssetRename) restoreUnknownMediaTransactionRecovery();
	const key = `article-commit:${storageSlug}`;
	const stored = sessionStorage.getItem(key);
	sessionStorage.removeItem(key);
	if (!stored) return;
	try {
		const commit = parseArticleCommitPayload(JSON.parse(stored));
		lastCommitUrl = commit.commitUrl;
		expectedArticleUrl = commit.expectedArticleUrl ?? "";
		successMessage = "文章已提交，可查看对应 GitHub Commit。";
	} catch {
		// 会话存储同样属于不可信浏览器输入；解析失败时静默丢弃，不生成任意外链。
	}
});

onDestroy(() => {
	if (draftTimer !== undefined) clearTimeout(draftTimer);
	if (slugCheckTimer !== undefined) clearTimeout(slugCheckTimer);
	revokeMediaPreviewUrls();
});

$effect(() => {
	void loadArticle();
});
</script>

<svelte:window onbeforeunload={handleBeforeUnload} />

<section class="editor-shell">
	<header class="editor-header">
		<div>
			<p class="eyebrow">{mode === "create" ? "New article" : "Edit article"}</p>
			<h2>{mode === "create" ? "新建文章" : "编辑文章"}</h2>
			<p>{mode === "create" ? "先以草稿方式创建，再逐步完善内容。" : `正在编辑 /${storageSlug ?? ""}`}</p>
		</div>
		<a class="back-link" href="/articles">返回文章列表</a>
	</header>

	{#if loading}
		<div class="status-card" role="status">正在安全加载文章内容…</div>
	{:else if !ready}
		<div class="status-card error" role="alert">
			<strong>文章无法打开</strong><p>{errorMessage}</p>
			<button type="button" onclick={loadArticle}>重试</button>
		</div>
	{:else}
		{#if draftCandidate}
			<div class="draft-card" role="status">
				<div><strong>发现本地草稿</strong><p>{draftMessage}</p></div>
				<div class="draft-actions">
					<button type="button" onclick={() => void restoreDraft()}>恢复草稿</button>
					<button class="secondary" type="button" onclick={discardDraft}>放弃草稿</button>
				</div>
			</div>
		{:else if draftMessage}
			<p class:warning={!draftStorageAvailable} class="draft-note" role="status">{draftMessage}</p>
		{/if}
		<form onsubmit={saveArticle} onchange={markDirty} oninput={markDirty}>
			<div class="editor-grid">
				<div class="main-column">
					<section class="panel meta-panel">
						<div class="meta-head">
							<div><h3>文章元信息 <small>Front-matter</small></h3><p>先填写文章信息，再在下方画布中编辑正文。保存时仍只提交结构化元信息与 Markdown。</p></div>
							<span class="meta-badge">结构化保存</span>
						</div>
						<div class="meta-grid">
							<label class="wide">标题<input bind:value={form.title} maxlength="200" required disabled={saving || mediaCommitLocked} oninput={updateTitle} placeholder="输入文章标题…" /></label>
							<label>发布日期<input bind:value={form.published} type="datetime-local" required disabled={saving || mediaCommitLocked} /></label>
							<label>更新时间<input bind:value={form.updated} type="datetime-local" disabled={saving || mediaCommitLocked} /></label>
							<label class="wide">描述<textarea bind:value={form.description} maxlength="500" rows="2" placeholder="添加一段简短描述（可选）" disabled={saving || mediaCommitLocked}></textarea></label>
							<label class="wide">封面图<input bind:value={form.image} maxlength="2048" placeholder="https://… 或 ./cover.webp" disabled={saving || mediaCommitLocked} onblur={() => void handleCoverInput()} /></label>
						</div>
						<div class="meta-groups">
							<section class="meta-group"><h4>内容组织</h4><div class="meta-group-grid"><label>标签<input bind:value={form.tags} placeholder="多个标签用英文逗号分隔" disabled={saving || mediaCommitLocked} /></label><label>分类<input bind:value={form.category} maxlength="100" disabled={saving || mediaCommitLocked} /></label><label>作者<input bind:value={form.author} maxlength="100" disabled={saving || mediaCommitLocked} /></label><label>语言<input bind:value={form.lang} maxlength="20" required disabled={saving || mediaCommitLocked} /></label></div></section>
							<section class="meta-group"><h4>发布设置</h4><div class="meta-group-grid"><label>存储 slug<input bind:value={form.storageSlug} maxlength="100" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required disabled={mode === "edit" || saving || mediaCommitLocked} oninput={handleStorageSlugInput} />{#if mode === "create" && slugAvailabilityMessage}<span class:available={slugAvailability === "available"} class:occupied={slugAvailability === "occupied"} class="slug-status">{slugAvailabilityMessage}</span>{/if}</label><label>公开 slug<input bind:value={form.publicSlug} maxlength="100" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="可选" disabled={saving || mediaCommitLocked} /></label><label class="check-row"><input bind:checked={form.draft} type="checkbox" disabled={saving || mediaCommitLocked} />保存为草稿</label><label class="check-row"><input bind:checked={form.pinned} type="checkbox" disabled={saving || mediaCommitLocked} />置顶文章</label><label class="check-row"><input bind:checked={form.comment} type="checkbox" disabled={saving || mediaCommitLocked} />允许评论</label></div></section>
						</div>
						<details class="meta-advanced"><summary>展开更多 Front-matter</summary><div class="meta-group-grid"><label>来源链接<input bind:value={form.sourceLink} maxlength="2048" type="url" disabled={saving || mediaCommitLocked} /></label><label>许可证名称<input bind:value={form.licenseName} maxlength="100" disabled={saving || mediaCommitLocked} /></label><label>许可证链接<input bind:value={form.licenseUrl} maxlength="2048" type="url" disabled={saving || mediaCommitLocked} /></label><label>访问密码<input bind:value={form.password} maxlength="200" type="password" autocomplete="new-password" disabled={saving || mediaCommitLocked} /></label><label>密码提示<input bind:value={form.passwordHint} maxlength="200" disabled={saving || mediaCommitLocked} /></label></div></details>
					</section>

					<section class="panel markdown-panel">
						<div class="section-heading">
							<div>
								<h3>Markdown 正文</h3>
								<p>画布使用受控 Markdown 投影；源码编辑保留完整 Markdown，预览不加载图片或嵌入内容。</p>
							</div>
							<div class="markdown-tools">
								<span>{form.markdown.length.toLocaleString()} 字符</span>
								<input bind:this={importInput} class="file-input" type="file" accept=".md,text/markdown,text/plain" disabled={saving || mediaCommitLocked} onchange={importMarkdownFile} />
								<button type="button" disabled={saving || mediaCommitLocked} onclick={() => importInput?.click()}>导入 .md</button>
							</div>
						</div>
						{#if visualEditorFailed}<div class="canvas-failure" role="alert"><strong>无法安全建立可视画布</strong><span>{errorMessage.replace("画布初始化失败：", "")}</span><button type="button" onclick={retryVisualEditor}>重试画布</button><button type="button" onclick={() => (markdownView = "write")}>转到 Markdown 源码</button></div>{/if}
						<div class="view-tabs" aria-label="Markdown 工作区视图">
							<button class:active={markdownView === "visual"} type="button" onclick={() => { errorMessage = ""; visualEditorFailed = false; markdownView = "visual"; }}>所见即所得</button>
							<button class:active={markdownView === "write"} type="button" onclick={() => { errorMessage = ""; markdownView = "write"; }}>Markdown 源码</button>
						</div>
						<EditorToolbar
							disabled={saving || mediaCommitLocked || markdownView === "preview" || (markdownView === "visual" && (!visualEditorReady || visualEditorFailed))}
							specialDisabled={saving || mediaCommitLocked || markdownView === "preview"}
							showLink={capabilities.articleLinks || capabilities.externalHttpsLinks}
							showImage={
								capabilities.externalHttpsLinks ||
								capabilities.smallImageUpload ||
								capabilities.pdfAttachmentUpload
							}
							oninline={applyInlineCommand}
							onblock={applyBlockCommand}
							onlink={openLinkDialog}
							onimage={openImageDialog}
							onheading={applyHeadingCommand}
							onundo={undoEditor}
							onredo={redoEditor}
							onspecial={openSpecialBlockDialog}
						/>
						<div class:split={markdownView === "split"} class="markdown-workspace">
							{#if markdownView === "visual"}
								<div class="workspace-pane visual-pane">
									{#key visualEditorGeneration}
										<MilkdownEditor
											value={form.markdown}
											disabled={saving || mediaCommitLocked}
											onchange={updateMarkdown}
											onerror={handleVisualEditorError}
											onsource={openSourceFromCanvas}
											onready={(handle) => { milkdownHandle = handle; visualEditorReady = true; visualEditorFailed = false; }}
											ondispose={() => { milkdownHandle = undefined; visualEditorReady = false; }}
										/>
									{/key}
								</div>
							{:else if markdownView === "write" || markdownView === "split"}
								<div class="workspace-pane"><CodeMirrorEditor value={form.markdown} onchange={updateMarkdown} disabled={saving || mediaCommitLocked} onready={(handle) => { codeMirrorHandle = handle; insertPendingSpecialBlock(handle); }} ondispose={() => (codeMirrorHandle = undefined)} /></div>
							{/if}
							{#if markdownView === "preview" || markdownView === "split"}
								<div class="workspace-pane"><MarkdownPreview markdown={form.markdown} /></div>
							{/if}
						</div>
					</section>


					{#if capabilities.articleAssetDetails && mode === "edit" && repositoryResources.length > 0}
						<ArticleAssetPanel
							resources={repositoryResources}
							referenceAnalysis={resourceReferenceAnalysis}
							allowRename={capabilities.articleAssetRename}
							headSha={expectedHeadSha}
							{saving}
							previewingFilename={previewingResourceFilename}
							preview={resourcePreview}
							commitStatus={mediaCommitState.status}
							commitPhrase={mediaCommitPhrase}
							commitEligible={mediaCommitEligible}
							confirmationValid={mediaConfirmationValid}
							commitMessage={mediaCommitMessage}
							commitResult={mediaCommitState.result}
							locked={mediaCommitLocked}
							onpreviewrename={previewRepositoryRename}
							onclearpreview={clearResourcePreview}
							oncommitphrase={(value) => (mediaCommitPhrase = value)}
							oncommit={() => void commitResourceTransaction()}
							onrefresharticle={() => void refreshArticleAfterMediaCommit()}
							refreshing={mediaCommitRefreshing}
						/>
						{#if resourceMessage}<p class="draft-note" role="status">{resourceMessage}</p>{/if}
					{/if}


					{#if stagedAssets.length > 0}
						<section class="panel media-panel" aria-labelledby="staged-media-title">
							<div class="section-heading">
								<div>
									<h3 id="staged-media-title">草稿资源</h3>
									<p>这些图片和附件将在下一次保存文章时与 index.md 一起提交。</p>
								</div>
								<span class="media-count">{stagedAssets.length}/{ARTICLE_ASSET_MAX_COUNT}</span>
							</div>
							<div class="media-list">
								{#each stagedAssets as record (record.localId)}
									<article class="media-item">
										<div class:attachment={!record.contentType.startsWith("image/")} class="media-thumbnail">
											{#if mediaPreviewUrls[record.localId]}
												<img src={mediaPreviewUrls[record.localId]} alt="" />
											{:else}
												<span>PDF</span>
											{/if}
										</div>
										<div class="media-details">
											<strong title={record.filename}>{record.filename}</strong>
											<span>{Math.max(1, Math.ceil(record.size / 1024))} KiB · {record.r2 ? "R2 已暂存" : "仅本地"}</span>
										</div>
										{#if record.contentType.startsWith("image/")}
											<div class="media-role" aria-label={`${record.filename} 的用途`}>
												<button class:active={record.role === "inline"} type="button" disabled={saving || mediaCommitLocked || removingMediaId !== "" || updatingMediaId !== ""} onclick={() => void updateStagedImageRole(record, "inline")}>正文</button>
												{#if capabilities.coverManagement}
													<button class:active={record.role === "cover"} type="button" disabled={!record.r2 || saving || mediaCommitLocked || removingMediaId !== "" || updatingMediaId !== ""} onclick={() => void updateStagedImageRole(record, "cover")}>封面</button>
												{/if}
											</div>
										{:else}
											<span class="attachment-role">附件</span>
										{/if}
										<div class="media-actions">
											<button type="button" disabled={!record.r2 || saving || mediaCommitLocked || removingMediaId !== "" || updatingMediaId !== ""} onclick={() => insertStagedAsset(record)}>插入</button>
											<button class="danger" type="button" disabled={saving || mediaCommitLocked || removingMediaId !== "" || updatingMediaId !== ""} onclick={() => void removeStagedAsset(record)}>{removingMediaId === record.localId ? "移除中…" : "移除"}</button>
										</div>
									</article>
								{/each}
							</div>
						</section>
					{/if}
				</div>

				<aside class="inspector" inert={mediaCommitLocked ? true : undefined}>
					<section class="panel inspector-card">
						<div class="card-title"><span>GitHub 提交目标</span><small>原子提交</small></div>
						<div class="repo-target"><div class="repo-target-label">内容仓库 · main</div><div class="repo-path">src/content/posts/{form.storageSlug || "article"}/</div><div class="info-row"><span>正文文件</span><strong>index.md</strong></div><div class="info-row"><span>本次资源</span><strong>{stagedAssets.length} 项</strong></div></div>
						<p class="safety-note blue-note">路径由 storage slug 与统一资源模型派生，不能输入任意仓库路径。</p>
					</section>

					<section class="panel inspector-card">
						<div class="card-title"><span>源码占位</span><small>Phase 3</small></div>
						<div class="info-list"><div class="info-row"><span>能力状态</span><strong>V0 仅保真</strong></div><div class="info-row"><span>画布行为</span><strong>不渲染 / 不执行</strong></div><div class="info-row"><span>编辑方式</span><strong>Markdown 源码</strong></div></div>
					</section>

					<section class="panel inspector-card">
						<div class="card-title"><span>文档状态</span><small>实时</small></div>
						<div class="info-list"><div class="info-row"><span>权威状态</span><strong>Front-matter + Markdown</strong></div><div class="info-row"><span>正文画布</span><strong>{visualEditorReady ? "临时投影" : "等待挂载"}</strong></div><div class="info-row"><span>资源</span><strong>{stagedAssets.length} 个待提交</strong></div>{#if expectedHeadSha}<div class="info-row"><span>版本锁</span><strong>已加载</strong></div>{/if}</div>
					</section>

					{#if capabilities.coverManagement}
						<section class="panel inspector-card cover-panel" aria-labelledby="article-cover-title">
							<div class="cover-heading">
								<div><h3 id="article-cover-title">封面资源</h3><p>元信息中的封面地址可在上方直接填写。</p></div>
								{#if form.image}<button class="danger-link" type="button" disabled={saving || mediaCommitLocked} onclick={() => void clearCover()}>移除封面引用</button>{/if}
							</div>
							<div class="cover-source-tabs" aria-label="封面来源">
								<button class:active={coverSource === "repository"} type="button" onclick={() => (coverSource = "repository")}>当前文章图片</button>
								<button class:active={coverSource === "remote"} type="button" onclick={() => (coverSource = "remote")}>HTTPS 地址</button>
							</div>
							{#if coverSource === "repository"}
								{#if mode === "edit" && repositoryCoverCandidates.length > 0}
									<div class="cover-candidates">
										{#each repositoryCoverCandidates as candidate (candidate.filename)}
											<button class:active={form.image === candidate.reference} type="button" disabled={saving || mediaCommitLocked} title={`Blob ${candidate.sha}`} onclick={() => void chooseRepositoryCover(candidate.reference)}>{candidate.filename}</button>
										{/each}
									</div>
								{:else}
									<p class="cover-note">当前 Page Bundle 没有可选的 JPEG、PNG、WebP 或 GIF 直接子文件。你也可以先上传图片，再在“草稿资源”中设为封面。</p>
								{/if}
							{:else}
								<label>受控外部封面<input bind:value={coverRemoteUrl} maxlength="2048" type="url" placeholder="https://images.example.com/cover.webp" disabled={saving || mediaCommitLocked} /></label>
								<button class="cover-apply" type="button" disabled={saving || mediaCommitLocked || !coverRemoteUrl.trim()} onclick={() => void applyRemoteCover()}>使用该 HTTPS 封面</button>
							{/if}
							<p class="cover-note">外部地址只接受无凭据、无查询参数的标准 HTTPS URL。本地上传封面复用草稿资源，文件与 index.md 将在一次 Commit 中提交。</p>
							{#if coverMessage}<p class="draft-note" role="status">{coverMessage}</p>{/if}
						</section>
					{/if}

				</aside>
			</div>

			<footer class="save-bar">
				<div>
					{#if mediaMessage}<p class:warning={!mediaStorageAvailable || stagedAssets.some((record) => !record.r2)} class="draft-note" role="status">{mediaMessage}</p>{/if}
					{#if errorMessage}<p class="save-error" role="alert">{errorMessage}</p>{/if}
					{#if successMessage}<p class="save-success" role="status">{successMessage}</p>{/if}
					{#if lastCommitUrl}<p><a class="commit-link" href={lastCommitUrl} target="_blank" rel="noopener noreferrer">查看 GitHub Commit</a></p>{/if}
					{#if expectedArticleUrl}<p><a class="commit-link" href={expectedArticleUrl} target="_blank" rel="noopener noreferrer">打开预计文章地址</a></p>{/if}
					{#if !errorMessage && !successMessage}<p>{dirty || stagedAssets.length > 0 || resourceChanges.length > 0 ? "有尚未保存的修改或资源" : "所有修改均已保存"}</p>{/if}
				</div>
				<div class="save-actions">
					{#if mode === "edit" && capabilities.articleDelete}
						<button class="delete-article" type="button" disabled={deleting || saving || mediaCommitLocked} onclick={() => void deleteCurrentArticle()}>{deleting ? "正在删除…" : "删除文章"}</button>
					{/if}
					<button name="action" value="draft" type="submit" disabled={deleting || saving || mediaCommitLocked || (!dirty && stagedAssets.length === 0 && resourceChanges.length === 0)}>{saving ? "正在提交…" : "保存 GitHub 草稿"}</button>
					<button class="publish" name="action" value="publish" type="submit" disabled={deleting || saving || mediaCommitLocked || (!dirty && stagedAssets.length === 0 && resourceChanges.length === 0)}>{saving ? "正在提交…" : "正式发布"}</button>
				</div>
			</footer>
		</form>
		{#if specialBlockOpen}
			<div class="modal-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) specialBlockOpen = false; }}>
				<section class="special-modal" role="dialog" aria-modal="true" aria-labelledby="special-block-title">
					<header class="modal-head"><strong id="special-block-title">插入特殊块</strong><button class="modal-close" type="button" aria-label="关闭" onclick={() => (specialBlockOpen = false)}>关闭</button></header>
					<div class="modal-body">
						<p class="modal-help">特殊块只写入经过约束的 Markdown 源码；返回画布后显示源码保真占位，不渲染、不执行、不请求第三方资源。</p>
						<div class="special-grid">
							{#each Object.entries(SPECIAL_BLOCK_LABELS) as [kind, item]}
								<button class="special-option" class:selected={kind === "video" && specialVideoConfigOpen} type="button" onclick={() => selectSpecialBlock(kind as SpecialBlockKind)}><strong>{item.title}</strong><span>{item.hint}</span></button>
							{/each}
						</div>
						{#if specialVideoConfigOpen}
						<div class="video-fields">
								<label>视频平台<select bind:value={specialVideoProvider}>
									<option value="youtube">YouTube</option>
									<option value="bilibili">B 站</option>
								</select></label>
								<label class="video-id-field">{specialVideoProvider === "youtube" ? "YouTube 视频 ID（仅视频）" : "B 站 BV 号"}<input bind:value={specialVideoId} maxlength={specialVideoProvider === "youtube" ? 11 : 12} inputmode="text" placeholder={specialVideoProvider === "youtube" ? "例如 dQw4w9WgXcQ" : "例如 BV1fK4y1s7Qf"} /></label>
						</div>
						<div class="video-insert-actions"><button class="video-insert" type="button" onclick={() => insertSpecialBlock("video")}>插入视频源码</button></div>
						{/if}
						{#if specialBlockError}<p class="modal-error" role="alert">{specialBlockError}</p>{/if}
					</div>
				</section>
			</div>
		{/if}
		{#if capabilities.externalHttpsLinks || capabilities.smallImageUpload || capabilities.pdfAttachmentUpload}
		<ImageDialog
			open={imageDialogOpen && !mediaCommitLocked}
			{capabilities}
			{mediaDraftKey}
			{mode}
			storageSlug={form.storageSlug}
			onclose={() => (imageDialogOpen = false)}
			oninsert={insertDialogMarkdown}
			onstaged={refreshStagedAssets}
		/>
		{/if}
		{#if capabilities.articleLinks || capabilities.externalHttpsLinks}
		<LinkDialog
			open={linkDialogOpen && !mediaCommitLocked}
			{capabilities}
			selectedText={savedDialogSelection.text}
			onclose={() => (linkDialogOpen = false)}
			oninsert={insertDialogMarkdown}
		/>
		{/if}
	{/if}
</section>

<style>
	:global(main:has(.editor-shell)) { width: min(1320px, 100%); padding: 1.3rem 1.5rem 6.5rem; }
	.editor-shell { display: grid; gap: 1rem; }
	.editor-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	.editor-header h2 { margin: 0; font-size: clamp(1.55rem, 3vw, 2.25rem); letter-spacing: -0.035em; }
	.editor-header p:not(.eyebrow) { margin: 0.5rem 0 0; color: var(--text-secondary); }
	.back-link { padding: 0.65rem 0.85rem; border: 1px solid var(--border); border-radius: 0.7rem; background: white; color: var(--text-secondary); font-size: 0.82rem; font-weight: 700; text-decoration: none; }
	.editor-grid { display: grid; grid-template-columns: minmax(0, 1fr) 290px; gap: 1rem; align-items: start; }
	.main-column, .side-column { display: grid; gap: 1rem; }
	.panel, .status-card, .draft-card { padding: 1rem; border: 1px solid var(--border); border-radius: 1rem; background: var(--surface); box-shadow: var(--shadow-sm); }
	.markdown-panel { padding: 0; overflow: visible; }
	.markdown-panel > .section-heading { padding: 1rem 1rem 0; }
	.markdown-panel > .view-tabs { margin-left: 1rem; }
	.markdown-panel :global(.editor-toolbar) { margin: 0; border-right: 0; border-left: 0; border-radius: 0; box-shadow: 0 10px 24px rgba(26, 39, 66, 0.08); }
	.visual-pane :global(.editor-host) { border: 0; border-radius: 0 0 1rem 1rem; }
	.markdown-workspace { gap: 0; }
	.markdown-workspace .workspace-pane { min-width: 0; }
	.meta-panel { padding: 1.15rem; border-radius: 1rem 1rem 0.75rem 0.75rem; }
	.meta-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.9rem; }
	.meta-head h3 { margin: 0; font-size: 0.88rem; }
	.meta-head h3 small { color: var(--text-muted); font-size: 0.7rem; font-weight: 650; }
	.meta-head p { max-width: 620px; margin: 0.25rem 0 0; color: var(--text-muted); font-size: 0.68rem; line-height: 1.5; }
	.meta-badge { flex: none; padding: 0.22rem 0.42rem; border-radius: 999px; background: var(--brand-soft); color: var(--brand-strong); font-size: 0.62rem; font-weight: 800; }
	.meta-grid, .meta-group-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem; }
	.meta-grid .wide, .meta-group-grid .wide { grid-column: 1 / -1; }
	.meta-grid label, .meta-group label, .meta-advanced label { margin: 0; }
	.meta-grid label:first-child input { min-height: 2.6rem; font-size: 1.05rem; font-weight: 750; }
	.meta-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.7rem; margin-top: 0.7rem; }
	.meta-group { padding: 0.75rem; border: 1px solid var(--border); border-radius: 0.7rem; background: var(--surface-subtle); }
	.meta-group h4 { margin: 0 0 0.65rem; color: var(--text-primary); font-size: 0.72rem; }
	.meta-advanced { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px dashed var(--border); }
	.meta-advanced summary { cursor: pointer; color: var(--text-secondary); font-size: 0.72rem; font-weight: 750; }
	.meta-advanced[open] summary { margin-bottom: 0.7rem; }
	.meta-advanced .meta-group-grid { padding-top: 0.1rem; }
	.canvas-failure { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 0.55rem; margin-bottom: 0.75rem; padding: 0.7rem; border: 1px solid #fecaca; border-radius: 0.7rem; background: #fff7f7; color: #991b1b; font-size: 0.72rem; }
	.canvas-failure strong { white-space: nowrap; }
	.canvas-failure span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.canvas-failure button { padding: 0.35rem 0.5rem; border: 1px solid #fca5a5; border-radius: 0.4rem; background: white; color: #991b1b; font: inherit; font-size: 0.66rem; font-weight: 750; cursor: pointer; }
	.modal-backdrop { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 1rem; background: rgba(15, 23, 42, 0.42); }
	.special-modal { width: min(600px, 100%); overflow: hidden; border: 1px solid var(--border); border-radius: 1rem; background: white; box-shadow: 0 24px 80px rgba(15, 23, 42, 0.25); }
	.modal-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.9rem 1rem; border-bottom: 1px solid var(--border); }
	.modal-head strong { font-size: 0.85rem; }
	.modal-close { padding: 0.35rem 0.55rem; border: 1px solid var(--border); border-radius: 0.45rem; background: white; color: var(--text-secondary); font: inherit; font-size: 0.7rem; font-weight: 750; cursor: pointer; }
	.modal-body { padding: 1rem; }
	.modal-help { margin: 0 0 0.85rem; color: var(--text-muted); font-size: 0.7rem; line-height: 1.55; }
	.special-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.65rem; }
	.special-option { min-height: 4.2rem; padding: 0.75rem; border: 1px solid var(--border); border-radius: 0.7rem; background: white; color: var(--text-primary); text-align: left; cursor: pointer; }
	.special-option:hover { border-color: #a5b4fc; background: #f8faff; }
	.special-option.selected { border-color: var(--brand-strong); background: var(--brand-soft); }
	.special-option strong, .special-option span { display: block; }
	.special-option strong { margin-bottom: 0.25rem; font-size: 0.76rem; }
	.special-option span { color: var(--text-muted); font-size: 0.65rem; line-height: 1.4; }
	.video-fields { display: grid; grid-template-columns: minmax(150px, 0.7fr) minmax(0, 1.3fr); gap: 0.7rem; margin: 0.85rem 0 0; }
	.video-fields label { display: grid; gap: 0.35rem; color: var(--text-secondary); font-size: 0.68rem; font-weight: 750; }
	.video-fields select, .video-fields input { width: 100%; min-height: 2.4rem; box-sizing: border-box; padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: 0.45rem; background: white; color: var(--text-primary); font: inherit; font-weight: 600; }
	.video-id-field { margin: 0; }
	.video-insert-actions { display: flex; justify-content: flex-end; margin-top: 0.65rem; }
	.video-insert { padding: 0.55rem 0.8rem; border: 0; border-radius: 0.45rem; background: var(--brand-strong); color: white; font: inherit; font-size: 0.7rem; font-weight: 800; cursor: pointer; }
	.modal-error { margin: 0.65rem 0 0; color: #b91c1c; font-size: 0.7rem; }
	.inspector { position: sticky; top: 1rem; display: grid; gap: 1rem; }
	.inspector-card { padding: 0.9rem; }
	.card-title { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; font-size: 0.78rem; font-weight: 850; }
	.card-title small { color: var(--text-muted); font-size: 0.62rem; font-weight: 650; }
	.repo-target { padding: 0.72rem; border: 1px solid #bfdbfe; border-radius: 0.65rem; background: #f8fbff; }
	.repo-target-label { color: #1d4ed8; font-size: 0.62rem; font-weight: 850; text-transform: uppercase; letter-spacing: 0.05em; }
	.repo-path { margin: 0.38rem 0 0.55rem; overflow-wrap: anywhere; color: var(--text-primary); font: 0.68rem/1.5 "Cascadia Code", Consolas, monospace; font-weight: 700; }
	.info-list { display: grid; gap: 0.55rem; }
	.info-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.7rem; color: var(--text-secondary); font-size: 0.68rem; }
	.info-row strong { color: var(--text-primary); text-align: right; }
	.safety-note { margin: 0; padding: 0.7rem; border-radius: 0.6rem; color: #166534; background: #f0fdf4; font-size: 0.66rem; line-height: 1.55; }
	.blue-note { margin-top: 0.65rem; color: #1e40af; background: #eff6ff; }
	.draft-card { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border-color: #f5c76b; background: #fffaf0; }
	.draft-card p, .draft-note { margin: 0.3rem 0 0; color: var(--text-secondary); font-size: 0.78rem; }
	.draft-actions { display: flex; gap: 0.55rem; flex: none; }
	.draft-actions button { padding: 0.6rem 0.8rem; border: 0; border-radius: 0.65rem; background: var(--brand); color: white; font: inherit; font-size: 0.78rem; font-weight: 750; cursor: pointer; }
	.draft-actions button.secondary { border: 1px solid var(--border); background: white; color: var(--text-secondary); }
	.draft-note { padding: 0 0.2rem; }
	.draft-note.warning { color: #9a3412; }
	.panel h3 { margin: 0 0 0.9rem; font-size: 0.95rem; }
	.writing-head { padding: clamp(1rem, 2.5vw, 1.7rem); }
	.title-field { margin: 0 0 0.6rem; }
	.title-field > span, .description-field > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
	.title-field input { padding: 0.25rem 0; border: 0; border-radius: 0; font-size: clamp(1.8rem, 4vw, 3rem); font-weight: 800; letter-spacing: -0.045em; line-height: 1.12; }
	.title-field input:focus, .description-field textarea:focus { border-color: transparent; outline: none; box-shadow: none; }
	.description-field { margin: 0; }
	.description-field textarea { resize: vertical; padding: 0.35rem 0; border: 0; border-radius: 0; color: var(--text-secondary); font-size: 0.92rem; line-height: 1.6; }
	.field-grid { display: grid; gap: 0.8rem; }
	.two-columns { grid-template-columns: 1fr 1fr; }
	label { display: grid; gap: 0.38rem; margin-bottom: 0.8rem; color: var(--text-secondary); font-size: 0.76rem; font-weight: 750; }
	input, textarea { width: 100%; padding: 0.7rem 0.75rem; border: 1px solid var(--border); border-radius: 0.65rem; background: white; color: var(--text-primary); font: inherit; font-weight: 450; }
	input:focus, textarea:focus { border-color: var(--brand); outline: 3px solid var(--brand-soft); }
	input:disabled { background: var(--surface-subtle); color: var(--text-muted); }
	.slug-status { color: var(--text-muted); font-size: 0.7rem; font-weight: 600; }
	.slug-status.available { color: var(--success); }
	.slug-status.occupied { color: #b91c1c; }
	.check-row { display: flex; align-items: center; gap: 0.6rem; }
	.check-row input { width: 1rem; height: 1rem; }
	.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 0.8rem; }
	.section-heading h3 { margin-bottom: 0.25rem; }
	.section-heading p { margin: 0; color: var(--text-muted); font-size: 0.76rem; }
	.section-heading span { flex: none; color: var(--text-muted); font-size: 0.72rem; }
	.markdown-tools { display: flex; align-items: center; gap: 0.65rem; flex: none; }
	.markdown-tools button { padding: 0.45rem 0.7rem; border: 1px solid var(--border); border-radius: 0.6rem; background: white; color: var(--text-secondary); font: inherit; font-size: 0.75rem; font-weight: 750; cursor: pointer; }
	.file-input { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	.view-tabs { display: inline-flex; gap: 0.2rem; margin-bottom: 0.75rem; padding: 0.2rem; border: 1px solid var(--border); border-radius: 0.65rem; background: var(--surface-subtle); }
	.view-tabs button { padding: 0.42rem 0.7rem; border: 0; border-radius: 0.48rem; background: transparent; color: var(--text-secondary); font: inherit; font-size: 0.76rem; font-weight: 750; cursor: pointer; }
	.view-tabs button.active { background: white; color: var(--brand-strong); box-shadow: var(--shadow-sm); }
	.markdown-panel :global(.editor-toolbar) { margin-bottom: 0.75rem; }
	.markdown-workspace { display: grid; gap: 0.8rem; }
	.markdown-workspace.split { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.workspace-pane { min-width: 0; }
	.media-count { padding: 0.25rem 0.45rem; border: 1px solid var(--border); border-radius: 0.4rem; background: var(--surface-subtle); font-weight: 750; }
	.media-list { display: grid; gap: 0.55rem; }
	.media-item { display: grid; grid-template-columns: 3.5rem minmax(0, 1fr) auto auto; align-items: center; gap: 0.75rem; min-width: 0; padding: 0.55rem; border: 1px solid var(--border); border-radius: 0.5rem; background: var(--surface-subtle); }
	.media-thumbnail { display: grid; place-items: center; width: 3.5rem; aspect-ratio: 1; overflow: hidden; border: 1px solid var(--border); border-radius: 0.4rem; background: white; }
	.media-thumbnail img { display: block; width: 100%; height: 100%; object-fit: cover; }
	.media-thumbnail.attachment { color: var(--brand-strong); font-size: 0.7rem; font-weight: 800; letter-spacing: 0.04em; }
	.media-details { display: grid; min-width: 0; gap: 0.2rem; }
	.media-details strong { overflow: hidden; font-size: 0.8rem; text-overflow: ellipsis; white-space: nowrap; }
	.media-details span { color: var(--text-muted); font-size: 0.7rem; }
	.media-role { display: inline-flex; padding: 0.15rem; border: 1px solid var(--border); border-radius: 0.45rem; background: white; }
	.media-role button { padding: 0.32rem 0.45rem; border: 0; border-radius: 0.3rem; background: transparent; color: var(--text-muted); font: inherit; font-size: 0.68rem; font-weight: 750; cursor: pointer; }
	.media-role button.active { background: var(--brand-soft); color: var(--brand-strong); }
	.media-role button:disabled { cursor: not-allowed; opacity: 0.5; }
	.attachment-role { padding: 0.32rem 0.5rem; border: 1px solid var(--border); border-radius: 0.4rem; background: white; color: var(--text-muted); font-size: 0.68rem; font-weight: 750; }
	.media-actions { display: flex; gap: 0.4rem; }
	.media-actions button { padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: 0.45rem; background: white; color: var(--text-secondary); font: inherit; font-size: 0.72rem; font-weight: 750; cursor: pointer; }
	.media-actions button.danger { border-color: #fecaca; color: #b91c1c; }
	.media-actions button:disabled { cursor: not-allowed; opacity: 0.5; }
	.repository-item { grid-template-columns: 3.5rem minmax(0, 1fr) auto; }
	.repository-actions { flex-wrap: wrap; justify-content: flex-end; }
	.pending-change { color: #9a3412 !important; font-weight: 750; }
	.cover-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.7rem; margin-bottom: 0.8rem; }
	.cover-heading h3 { margin-bottom: 0.25rem; }
	.cover-heading p, .cover-note { margin: 0; color: var(--text-muted); font-size: 0.7rem; line-height: 1.5; }
	.danger-link { flex: none; padding: 0.35rem 0.45rem; border: 1px solid #fecaca; border-radius: 0.45rem; background: white; color: #b91c1c; font: inherit; font-size: 0.68rem; font-weight: 750; cursor: pointer; }
	.cover-source-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 0.2rem; margin-bottom: 0.75rem; padding: 0.2rem; border: 1px solid var(--border); border-radius: 0.55rem; background: var(--surface-subtle); }
	.cover-source-tabs button { padding: 0.4rem; border: 0; border-radius: 0.4rem; background: transparent; color: var(--text-muted); font: inherit; font-size: 0.68rem; font-weight: 750; cursor: pointer; }
	.cover-source-tabs button.active { background: white; color: var(--brand-strong); box-shadow: var(--shadow-sm); }
	.cover-candidates { display: grid; gap: 0.35rem; margin-bottom: 0.75rem; }
	.cover-candidates button, .cover-apply { overflow: hidden; padding: 0.5rem 0.6rem; border: 1px solid var(--border); border-radius: 0.5rem; background: white; color: var(--text-secondary); font: inherit; font-size: 0.7rem; font-weight: 700; text-align: left; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
	.cover-candidates button.active { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-strong); }
	.cover-apply { margin: -0.25rem 0 0.75rem; color: white; text-align: center; background: var(--brand); }
	.cover-apply:disabled, .danger-link:disabled { cursor: not-allowed; opacity: 0.5; }
	.advanced-panel summary { cursor: pointer; color: var(--text-primary); font-size: 0.9rem; font-weight: 750; }
	.advanced-panel[open] summary { margin-bottom: 1rem; }
	.save-bar { position: fixed; left: 250px; right: 0; bottom: 0; z-index: 8; display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin: 0; padding: 0.8rem 1.5rem; border: 0; border-top: 1px solid var(--border); border-radius: 0; background: rgba(255, 255, 255, 0.96); box-shadow: 0 -10px 32px rgba(26, 39, 66, 0.06); backdrop-filter: blur(16px); }
	.save-bar p { margin: 0; color: var(--text-muted); font-size: 0.8rem; }
	.save-bar button, .status-card button { border: 0; border-radius: 0.7rem; background: var(--brand); color: white; font: inherit; font-weight: 750; cursor: pointer; }
	.save-bar button { padding: 0.72rem 1rem; }
	.save-actions { display: flex; gap: 0.6rem; flex: none; }
	.save-actions button.publish { background: var(--brand-strong); }
	.save-actions button.delete-article { border: 1px solid #fecaca; background: white; color: #b91c1c; }
	.status-card button { margin-top: 0.8rem; padding: 0.6rem 0.8rem; }
	.save-bar button:disabled { cursor: not-allowed; opacity: 0.55; }
	.save-error { color: #b91c1c !important; }
	.save-success { color: var(--success) !important; }
	.commit-link { color: var(--brand-strong); font-weight: 750; }
	.status-card.error { border-color: #fecaca; background: #fff7f7; color: #991b1b; }
	.status-card p { margin: 0.35rem 0 0; }
	@media (max-width: 1050px) { .markdown-workspace.split { grid-template-columns: 1fr; } }
	@media (max-width: 880px) { :global(main:has(.editor-shell)) { padding-inline: 0.85rem; } .editor-grid { grid-template-columns: 1fr; } .inspector { position: static; grid-template-columns: repeat(2, minmax(0, 1fr)); } .meta-groups { grid-template-columns: 1fr; } }
	@media (max-width: 760px) {
		:global(main:has(.editor-shell)) { padding: 0.9rem 0.75rem 9.5rem; }
		.editor-shell { gap: 0.75rem; }
		.editor-header { align-items: stretch; flex-direction: column; gap: 0.7rem; }
		.editor-header h2 { font-size: 1.55rem; }
		.back-link { align-self: flex-start; }
		.panel, .meta-panel { border-radius: 0.75rem; }
		.meta-panel { padding: 0.85rem; }
		.meta-head { flex-direction: column; gap: 0.55rem; }
		.meta-badge { align-self: flex-start; }
		.section-heading { flex-direction: column; gap: 0.65rem; }
		.markdown-tools { width: 100%; justify-content: space-between; }
		.markdown-tools button { flex: none; }
		.view-tabs { display: flex; width: calc(100% - 1.7rem); margin-right: 0.85rem; }
		.view-tabs button { flex: 1; min-width: 0; }
		.inspector { grid-template-columns: 1fr; }
		.save-bar { left: 0; padding: 0.55rem 0.75rem max(0.55rem, env(safe-area-inset-bottom)); }
		.save-bar > div:first-child { min-width: 0; }
		.save-bar p { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.save-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.45rem; }
		.save-actions button { min-width: 0; padding: 0.62rem 0.45rem; font-size: 0.72rem; }
		.save-actions .delete-article { grid-column: 1 / -1; }
		.special-grid { grid-template-columns: 1fr; }
		.video-fields { grid-template-columns: 1fr; }
		.video-id-field { margin-top: 0; }
		.special-modal { max-height: calc(100dvh - 2rem); overflow: auto; }
	}
	@media (max-width: 620px) {
		.meta-grid, .meta-group-grid { grid-template-columns: 1fr; }
		.meta-grid .wide, .meta-group-grid .wide { grid-column: auto; }
		.canvas-failure { grid-template-columns: 1fr; }
		.canvas-failure span { white-space: normal; }
		.media-item { grid-template-columns: 3.5rem minmax(0, 1fr); }
		.media-role, .media-actions { grid-column: 1 / -1; }
		.media-role button, .media-actions button { flex: 1; }
	}
	@media (max-width: 420px) {
		:global(main:has(.editor-shell)) { padding-inline: 0.55rem; }
		.markdown-panel > .section-heading { padding-inline: 0.75rem; }
		.markdown-panel > .view-tabs { margin-left: 0.75rem; }
		.markdown-tools { align-items: flex-start; flex-direction: column; }
		.markdown-tools button { width: 100%; }
		.save-actions button { font-size: 0.68rem; }
	}
</style>
