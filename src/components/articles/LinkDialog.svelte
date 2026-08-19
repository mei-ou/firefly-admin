<script lang="ts">
import { onDestroy } from "svelte";
import type { AdminCapabilitySnapshot } from "../../types/capability";
import { type ArticleLinkTarget, parseArticleLinkTargetsPayload } from "./article-link-targets";
import { createMarkdownLink } from "./editor-commands";
import {
	parseExternalLinkTarget,
	parseHeadingLinkTarget,
	parseInternalLinkTarget,
} from "./markdown-target-validation";

type LinkSource = "article" | "heading" | "external";

interface Props {
	open: boolean;
	capabilities: AdminCapabilitySnapshot;
	selectedText?: string;
	onclose: () => void;
	oninsert: (markdown: string) => void;
}

let { open, capabilities, selectedText = "", onclose, oninsert }: Props = $props();
let source = $state<LinkSource>(
	capabilities.externalHttpsLinks ? "external" : capabilities.articleLinks ? "article" : "external",
);
let text = $state("");
let title = $state("");
let articlePath = $state("");
let heading = $state("");
let externalUrl = $state("");
let query = $state("");
let targets = $state<ArticleLinkTarget[]>([]);
let selectedArticle = $state<ArticleLinkTarget | null>(null);
let loadingTargets = $state(false);
let targetsLoaded = $state(false);
let targetsTruncated = $state(false);
let errorMessage = $state("");
let previousOpen = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let requestController: AbortController | undefined;
let requestSequence = 0;

$effect(() => {
	if (open && !previousOpen) {
		text = selectedText;
		errorMessage = "";
		if (source !== "external") void loadTargets(query);
	}
	previousOpen = open;
});

$effect(() => {
	if (!open || source === "external") return;
	if (searchTimer !== undefined) clearTimeout(searchTimer);
	searchTimer = setTimeout(() => void loadTargets(query), 250);
});

onDestroy(() => {
	if (searchTimer !== undefined) clearTimeout(searchTimer);
	requestController?.abort();
});

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function loadTargets(searchQuery: string): Promise<void> {
	if (!capabilities.articleLinks) return;
	const sequence = ++requestSequence;
	requestController?.abort();
	requestController = new AbortController();
	loadingTargets = true;
	errorMessage = "";
	try {
		const parameters = new URLSearchParams();
		const normalizedQuery = searchQuery.trim();
		if (normalizedQuery) parameters.set("query", normalizedQuery);
		const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
		const response = await fetch(`/api/articles/link-targets${suffix}`, {
			headers: { Accept: "application/json" },
			signal: requestController.signal,
		});
		const body = await readJson(response);
		if (!response.ok) throw new Error("文章链接索引暂时无法加载。");
		const parsed = parseArticleLinkTargetsPayload(body);
		if (sequence !== requestSequence) return;
		targets = parsed.items;
		targetsTruncated = parsed.truncated;
		targetsLoaded = true;
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return;
		if (sequence !== requestSequence) return;
		targets = [];
		targetsLoaded = false;
		errorMessage = error instanceof Error ? error.message : "文章链接索引暂时无法加载。";
	} finally {
		if (sequence === requestSequence) loadingTargets = false;
	}
}

function selectSource(nextSource: LinkSource): void {
	if (
		(nextSource === "external" && !capabilities.externalHttpsLinks) ||
		(nextSource !== "external" && !capabilities.articleLinks)
	) {
		return;
	}
	source = nextSource;
	errorMessage = "";
	if (nextSource !== "external" && !targetsLoaded) void loadTargets(query);
}

function selectArticle(target: ArticleLinkTarget): void {
	selectedArticle = target;
	articlePath = target.href;
	if (!text.trim()) text = target.title;
	if (source === "heading") heading = "";
}

function selectHeading(target: ArticleLinkTarget, headingId: string, headingText: string): void {
	selectArticle(target);
	heading = `${target.href}#${headingId}`;
	if (!text.trim() || text === target.title) text = headingText;
}

function close(): void {
	errorMessage = "";
	onclose();
}

function insertLink(): void {
	errorMessage = "";
	try {
		let href: string;
		if (source === "article") href = parseInternalLinkTarget(articlePath);
		else if (source === "heading") {
			href = heading.startsWith("/")
				? parseInternalLinkTarget(heading)
				: parseHeadingLinkTarget(heading);
		} else href = parseExternalLinkTarget(externalUrl);
		oninsert(createMarkdownLink({ text, href, title }));
		close();
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : "链接信息无效。";
	}
}
</script>

{#if open}
	<div class="dialog-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && close()}>
		<section class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="link-dialog-title">
			<header>
				<div><p class="eyebrow">Insert link</p><h3 id="link-dialog-title">插入链接</h3></div>
				<button class="icon-button" type="button" aria-label="关闭" onclick={close}>×</button>
			</header>

			<div class="source-tabs" role="tablist" aria-label="链接目标">
				{#if capabilities.articleLinks}
					<button class:active={source === "article"} type="button" onclick={() => selectSource("article")}>站内文章</button>
					<button class:active={source === "heading"} type="button" onclick={() => selectSource("heading")}>文章段落</button>
				{/if}
				{#if capabilities.externalHttpsLinks}
					<button class:active={source === "external"} type="button" onclick={() => selectSource("external")}>外部链接</button>
				{/if}
			</div>

			{#if source === "article" || source === "heading"}
				<label>搜索文章<input bind:value={query} maxlength="100" placeholder="标题、分类、标签或 slug" /></label>
				<div class="target-list" aria-busy={loadingTargets}>
					{#if loadingTargets}<p class="status-card">正在加载文章链接索引…</p>
					{:else if targets.length === 0}<p class="status-card">没有找到可用文章。</p>
					{:else}
						{#each targets as target (target.storageSlug)}
							<article class:selected={selectedArticle?.storageSlug === target.storageSlug} class="target-card">
								<button class="article-target" type="button" onclick={() => selectArticle(target)}>
									<strong>{target.title}</strong>
									<span>{target.category ?? "未分类"}{target.tags.length ? ` · ${target.tags.join(" / ")}` : ""}</span>
									{#if target.description}<small>{target.description}</small>{/if}
								</button>
								{#if source === "heading" && selectedArticle?.storageSlug === target.storageSlug}
									<div class="heading-list">
									{#if target.headings.length === 0}<p>该文章没有 H1–H6 标题。</p>
									{:else}
										{#each target.headings as item (`${item.depth}-${item.id}`)}
											<button type="button" style={`--heading-indent: ${item.depth - 1}`} onclick={() => selectHeading(target, item.id, item.text)}>
													<span>H{item.depth}</span>{item.text}
												</button>
											{/each}
										{/if}
									</div>
								{/if}
							</article>
						{/each}
					{/if}
				</div>
				{#if targetsTruncated}<p class="scope-note">仓库文章数量超过当前扫描上限；请缩小搜索词，或等待后续持久化索引。</p>{/if}
				{#if source === "article"}
					<label>站内文章路径<input bind:value={articlePath} placeholder="/posts/article-slug/" /></label>
				{:else}
					<label>文章段落路径<input bind:value={heading} placeholder="/posts/article-slug/#section-heading 或 #section-heading" /></label>
				{/if}
			{:else}
				<label>外部 HTTPS 地址<input bind:value={externalUrl} type="url" placeholder="https://example.com/path" /></label>
			{/if}

			<div class="field-grid">
				<label>链接文字<input bind:value={text} maxlength="300" /></label>
				<label>悬停标题（可选）<input bind:value={title} maxlength="300" /></label>
			</div>

			{#if errorMessage}<p class="dialog-error" role="alert">{errorMessage}</p>{/if}
			<footer><button class="secondary" type="button" onclick={close}>取消</button><button type="button" onclick={insertLink}>插入链接</button></footer>
		</section>
	</div>
{/if}

<style>
	.dialog-backdrop { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center; padding: 1rem; background: rgba(15, 23, 42, 0.36); backdrop-filter: blur(3px); }
	.dialog-card { width: min(680px, 100%); max-height: min(760px, calc(100vh - 2rem)); overflow: auto; padding: 1.1rem; border: 1px solid var(--border); border-radius: 1rem; background: white; box-shadow: 0 24px 80px rgba(15, 23, 42, 0.22); }
	header, footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	header h3 { margin: 0.15rem 0 0; font-size: 1.2rem; }
	.eyebrow { margin: 0; color: var(--brand-strong); font-size: 0.66rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
	.icon-button { width: 2rem; height: 2rem; border: 0; border-radius: 999px; background: var(--surface-subtle); color: var(--text-secondary); font-size: 1.3rem; cursor: pointer; }
	.source-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.25rem; margin: 1rem 0; padding: 0.25rem; border-radius: 0.7rem; background: var(--surface-subtle); }
	.source-tabs button { padding: 0.55rem; border: 0; border-radius: 0.5rem; background: transparent; color: var(--text-secondary); font: inherit; font-size: 0.78rem; font-weight: 750; cursor: pointer; }
	.source-tabs button.active { background: white; color: var(--brand-strong); box-shadow: var(--shadow-sm); }
	label { display: grid; gap: 0.38rem; margin-bottom: 0.8rem; color: var(--text-secondary); font-size: 0.76rem; font-weight: 750; }
	input { width: 100%; padding: 0.7rem 0.75rem; border: 1px solid var(--border); border-radius: 0.65rem; background: white; color: var(--text-primary); font: inherit; }
	input:focus { border-color: var(--brand); outline: 3px solid var(--brand-soft); }
	.target-list { display: grid; gap: 0.45rem; max-height: 290px; margin: -0.15rem 0 0.8rem; overflow: auto; }
	.target-card { border: 1px solid var(--border); border-radius: 0.7rem; background: white; overflow: hidden; }
	.target-card.selected { border-color: var(--brand); box-shadow: 0 0 0 2px var(--brand-soft); }
	.article-target { display: grid; gap: 0.25rem; width: 100%; padding: 0.72rem; border: 0; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; }
	.article-target span, .article-target small { color: var(--text-muted); font-size: 0.72rem; }
	.heading-list { display: grid; gap: 0.18rem; padding: 0.35rem 0.5rem 0.55rem; border-top: 1px solid var(--border); background: var(--surface-subtle); }
	.heading-list button { display: flex; gap: 0.45rem; align-items: center; padding: 0.42rem 0.5rem 0.42rem calc(0.5rem + var(--heading-indent) * 0.65rem); border: 0; border-radius: 0.45rem; background: transparent; color: var(--text-secondary); font: inherit; font-size: 0.75rem; text-align: left; cursor: pointer; }
	.heading-list button:hover { background: white; color: var(--brand-strong); }
	.heading-list button span { color: var(--text-muted); font-size: 0.62rem; font-weight: 800; }
	.heading-list p, .status-card, .scope-note { margin: 0; padding: 0.65rem; color: var(--text-muted); font-size: 0.74rem; }
	.status-card { border: 1px dashed var(--border); border-radius: 0.65rem; background: var(--surface-subtle); }
	.scope-note { padding: 0 0 0.75rem; color: #92400e; }
	.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; margin-top: 1rem; }
	.dialog-error { margin: 0.5rem 0; color: #b91c1c; font-size: 0.78rem; }
	footer { justify-content: flex-end; margin-top: 1rem; }
	footer button { padding: 0.65rem 0.9rem; border: 0; border-radius: 0.65rem; background: var(--brand); color: white; font: inherit; font-weight: 750; cursor: pointer; }
	footer button.secondary { border: 1px solid var(--border); background: white; color: var(--text-secondary); }
	@media (max-width: 560px) { .field-grid { grid-template-columns: 1fr; gap: 0; } .source-tabs { grid-template-columns: 1fr; } }
</style>
