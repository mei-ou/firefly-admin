<script lang="ts">
import type { RemoteArticleData } from "./article-editor-state";
import type {
	MediaTransactionCommitResult,
	MediaTransactionCommitStatus,
	MediaTransactionPreviewData,
} from "./media-transaction-preview-state";

type Resource = NonNullable<RemoteArticleData["resources"]>[number];

interface Props {
	resources: NonNullable<RemoteArticleData["resources"]>;
	referenceAnalysis: NonNullable<RemoteArticleData["resourceReferenceAnalysis"]>;
	allowRename?: boolean;
	headSha: string;
	saving: boolean;
	previewingFilename: string;
	preview: MediaTransactionPreviewData | null;
	commitStatus: MediaTransactionCommitStatus;
	commitPhrase: string;
	commitEligible: boolean;
	confirmationValid: boolean;
	commitMessage: string;
	commitResult: MediaTransactionCommitResult | null;
	locked: boolean;
	onpreviewrename: (resource: Resource) => void;
	onclearpreview: () => void;
	oncommitphrase: (value: string) => void;
	oncommit: () => void;
	onrefresharticle: () => void;
	refreshing: boolean;
}

let {
	resources,
	referenceAnalysis,
	allowRename = false,
	headSha,
	saving,
	previewingFilename,
	preview,
	commitStatus,
	commitPhrase,
	commitEligible,
	confirmationValid,
	commitMessage,
	commitResult,
	locked,
	onpreviewrename,
	onclearpreview,
	oncommitphrase,
	oncommit,
	onrefresharticle,
	refreshing,
}: Props = $props();

function formatBytes(size: number | null): string {
	if (size === null) return "上游未提供";
	if (size < 1_024) return `${size} B`;
	if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KiB`;
	return `${(size / 1_048_576).toFixed(2)} MiB`;
}

function roleLabel(resource: Resource): string {
	if (resource.role === "cover") return "文章封面";
	if (resource.role === "inline") return "正文图片";
	if (resource.role === "attachment") return "正文附件";
	return referenceAnalysis.complete ? "未发现引用" : "引用状态未知";
}

function referenceLabel(reference: Resource["references"][number]): string {
	if (reference.source === "frontmatter-image") return "Frontmatter image";
	const source = reference.source === "markdown-image" ? "Markdown 图片" : "Markdown 链接";
	return `${source} · 第 ${reference.line} 行，第 ${reference.column} 列`;
}

function riskLabel(resource: Resource): string {
	const level = resource.riskLevel === "low" ? "低" : resource.riskLevel === "medium" ? "中" : "高";
	return `${resource.policyLevel} / ${level}风险`;
}

function previewReferenceLabel(
	reference: MediaTransactionPreviewData["references"][number],
): string {
	if (reference.source === "frontmatter-image") return "Frontmatter image";
	const source = reference.source === "markdown-image" ? "Markdown 图片" : "Markdown 链接";
	return `${source} · 第 ${reference.line} 行，第 ${reference.column} 列`;
}
</script>

<section class="panel media-panel asset-panel" aria-labelledby="repository-media-title">
	<div class="section-heading">
		<div>
			<h3 id="repository-media-title">仓库已有资源</h3>
			<p>只读详情来自同一不可变 Commit；重命名需先 Preview，再由独立媒体事务原子提交。</p>
		</div>
		<span class="media-count">{resources.length}</span>
	</div>
	<div class="snapshot-bar">
		<span>读取基准 HEAD</span>
		<code title={headSha}>{headSha}</code>
	</div>
	{#if !referenceAnalysis.complete}
		<div class="analysis-warning" role="alert">
			<strong>引用分析不完整</strong>
			<span>检测到 {referenceAnalysis.issues.length} 个未知或不受支持的本地引用语法；所有资源均按 L2 失败关闭，不能视为未引用。</span>
		</div>
	{/if}
	<div class="asset-list">
		{#each resources as resource (resource.assetId)}
			<article class="asset-item">
				<header>
					<div>
						<strong title={resource.filename}>{resource.filename}</strong>
						<span>{resource.contentType ?? "未知/禁止类型"} · {formatBytes(resource.size)} · {roleLabel(resource)}</span>
					</div>
					<span class:risk-high={resource.riskLevel === "high"} class="risk-badge">{riskLabel(resource)}</span>
				</header>
				<dl>
					<div><dt>Blob SHA</dt><dd><code title={resource.blobSha}>{resource.blobSha}</code></dd></div>
					<div><dt>仓库路径</dt><dd><code>{resource.repositoryPath}</code></dd></div>
					<div><dt>引用数量</dt><dd>{referenceAnalysis.complete ? resource.references.length : `已观察到 ${resource.references.length}`}</dd></div>
					<div><dt>可变状态</dt><dd>{resource.mutable ? (resource.requiresImpactPreview ? "需影响预览" : "允许低风险操作") : "永久禁止"}</dd></div>
				</dl>
				{#if resource.references.length > 0}
					<ul class="reference-list">
						{#each resource.references as reference}
							<li>{referenceLabel(reference)}：<code>{reference.target}</code></li>
						{/each}
					</ul>
				{/if}
				{#if resource.riskReasons.length > 0}
					<p class="risk-reasons">策略原因：{resource.riskReasons.join(" · ")}</p>
				{/if}
				<div class="asset-actions">
					<button type="button" disabled title="替换将在阶段 E3 接入 Preview/Commit">替换（待开放）</button>
					{#if allowRename}
						<button
							type="button"
							disabled={saving || locked || previewingFilename !== "" || !resource.mutable}
							onclick={() => onpreviewrename(resource)}
						>{previewingFilename === resource.filename ? "正在预览…" : "预览重命名"}</button>
					{/if}
					<button class="danger" type="button" disabled title="删除将在阶段 F 接入危险确认">删除（待开放）</button>
				</div>
			</article>
		{/each}
	</div>
	{#if preview}
		<aside class="preview-card" aria-labelledby="resource-preview-title">
			<div class="section-heading">
				<div>
					<h4 id="resource-preview-title">重命名影响预览</h4>
					<p><code>{preview.source.filename}</code> → <code>{preview.destination.filename}</code></p>
				</div>
				<span class:risk-high={preview.riskLevel === "high"} class="risk-badge">{preview.policyLevel} / {preview.riskLevel}</span>
			</div>
			<dl>
				<div><dt>Preview ID</dt><dd><code>{preview.previewId}</code></dd></div>
				<div><dt>到期时间</dt><dd>{new Date(preview.expiresAt).toLocaleString()}</dd></div>
				<div><dt>Tree 影响</dt><dd>{preview.effects.length} 项</dd></div>
				<div><dt>引用影响</dt><dd>{preview.references.length} 处</dd></div>
			</dl>
			{#if preview.references.length > 0}
				<ul class="reference-list">
					{#each preview.references as reference}
						<li>{previewReferenceLabel(reference)}：<code>{reference.currentTarget}</code> → <code>{reference.proposedTarget}</code></li>
					{/each}
				</ul>
			{/if}
			{#if preview.confirmation.kind === "phrase"}
				<label class="confirmation-field">
					<span>精确输入确认短语：<code>{preview.confirmation.phrase}</code></span>
					<input
						value={commitPhrase}
						maxlength="120"
						disabled={locked || commitStatus === "consumed" || commitStatus === "refresh-failed"}
						oninput={(event) => oncommitphrase(event.currentTarget.value)}
					/>
				</label>
			{:else}
				<p class="preview-note">此操作使用显式按钮确认，提交请求将发送 <code>{`{ kind: "button" }`}</code>。</p>
			{/if}
			{#if commitStatus === "refresh-failed"}
				<p class="commit-status warning" role="alert">提交已成功，但刷新失败；禁止重提交。请重新加载文章以恢复编辑。</p>
			{:else if commitStatus === "committing"}
				<p class="commit-status" role="status">正在提交媒体事务，已锁定 Preview、文章保存及资源变更。</p>
			{:else if commitStatus === "unknown"}
				<p class="commit-status warning" role="alert">提交结果待确认，只能使用原幂等键重试；不得生成新 Preview 或重新提交。</p>
			{:else if commitStatus === "consumed"}
				<p class="commit-status success" role="status">媒体事务已提交成功。</p>
			{:else if Date.parse(preview.expiresAt) <= Date.now()}
				<p class="commit-status error" role="alert">影响预览已到期，请重新生成 Preview。</p>
			{/if}
			{#if commitMessage}<p class="commit-status" role="status">{commitMessage}</p>{/if}
			{#if commitResult}
				<p class="commit-url"><a href={commitResult.url} target="_blank" rel="noopener noreferrer">查看媒体 Commit</a></p>
			{/if}
			<div class="asset-actions">
				<button type="button" disabled={locked || commitStatus === "consumed" || commitStatus === "refresh-failed"} onclick={onclearpreview}>关闭预览</button>
				{#if commitStatus === "refresh-failed"}
					<button class="commit" type="button" disabled={refreshing} onclick={onrefresharticle}>{refreshing ? "重新加载中…" : "重新加载文章"}</button>
				{:else}
					<button
						class="commit"
						type="button"
						disabled={!commitEligible || !confirmationValid}
						onclick={oncommit}
					>{commitStatus === "committing" ? "提交中…" : commitStatus === "unknown" ? "使用原 Key 重试确认" : "确认并提交重命名"}</button>
				{/if}
			</div>
		</aside>
	{/if}
</section>

<style>
.asset-panel { display: grid; gap: 1rem; }
.snapshot-bar, .analysis-warning { display: grid; gap: .35rem; padding: .8rem 1rem; border-radius: 12px; background: #f8fafc; border: 1px solid #dbe4ee; }
.snapshot-bar code, dd code { overflow-wrap: anywhere; }
.analysis-warning { color: #8a3b12; background: #fff7ed; border-color: #fed7aa; }
.asset-list { display: grid; gap: .85rem; }
.asset-item, .preview-card { display: grid; gap: .8rem; padding: 1rem; border: 1px solid #dbe4ee; border-radius: 14px; background: #fff; }
.preview-card { border-color: #b9c9ef; background: #f7f9ff; }
.preview-card h4, .preview-card p { margin: 0; }
.preview-note { color: #46566d; line-height: 1.6; }
.confirmation-field { display: grid; gap: .4rem; color: #46566d; font-size: .85rem; font-weight: 700; }
.confirmation-field input { width: 100%; padding: .55rem .65rem; border: 1px solid #b9c9ef; border-radius: 8px; font: inherit; }
.commit-status, .commit-url { margin: 0; color: #46566d; font-size: .85rem; }
.commit-status.warning, .commit-status.error { color: #a42b24; font-weight: 700; }
.commit-status.success, .commit-url a { color: #23643f; font-weight: 700; }
.asset-actions button.commit { border-color: #4969b2; background: #4969b2; color: #fff; }
.asset-item header { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
.asset-item header > div { display: grid; gap: .25rem; min-width: 0; }
.asset-item header span, dt, .risk-reasons, .reference-list { color: #58677a; font-size: .85rem; }
.risk-badge { flex: none; padding: .25rem .55rem; border-radius: 999px; background: #e8f5ee; color: #23643f !important; font-weight: 700; }
.risk-badge.risk-high { background: #fff1f0; color: #a42b24 !important; }
dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem 1rem; margin: 0; }
dl div { display: grid; gap: .15rem; }
dd { margin: 0; color: #223047; }
.reference-list { margin: 0; padding-left: 1.2rem; display: grid; gap: .35rem; }
.risk-reasons { margin: 0; overflow-wrap: anywhere; }
.asset-actions { display: flex; justify-content: flex-end; align-items: center; gap: .5rem; flex-wrap: wrap; }
.asset-actions button { border: 1px solid #c7d2df; background: #fff; color: #26364d; padding: .45rem .7rem; border-radius: 8px; cursor: pointer; }
.asset-actions button:disabled { cursor: not-allowed; opacity: .5; }
.asset-actions .danger { color: #a42b24; border-color: #f0b7b3; }
.pending-change { margin-right: auto; color: #8a4b08; font-size: .85rem; font-weight: 700; }
@media (max-width: 720px) { dl { grid-template-columns: 1fr; } .asset-item header { align-items: stretch; flex-direction: column; } .risk-badge { width: fit-content; } }
</style>
