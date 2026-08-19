<script lang="ts">
import { onMount } from "svelte";
import { renderSafeMarkdown } from "./markdown-preview";

interface Props {
	markdown?: string;
}

let { markdown = "" }: Props = $props();
let browserReady = $state(false);
// DOMPurify 和二次链接检查依赖真实 DOM。SSR 阶段不生成 HTML，避免服务端误用浏览器全局。
let safeHtml = $derived(browserReady ? renderSafeMarkdown(markdown) : "");

onMount(() => {
	browserReady = true;
});
</script>

<div class="preview-shell">
	{#if markdown.trim().length === 0}
		<div class="preview-empty">输入 Markdown 后，安全预览会显示在这里。</div>
	{:else}
		<article class="prose">{@html safeHtml}</article>
	{/if}
</div>

<style>
	.preview-shell {
		overflow: auto;
		min-height: 520px;
		max-height: 720px;
		padding: 1.25rem;
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		background: white;
	}

	.preview-empty {
		display: grid;
		min-height: 470px;
		place-items: center;
		color: var(--text-muted);
		font-size: 0.85rem;
		text-align: center;
	}

	.prose {
		color: var(--text-primary);
		font-size: 0.94rem;
		line-height: 1.75;
	}

	.prose :global(h1),
	.prose :global(h2),
	.prose :global(h3),
	.prose :global(h4) {
		margin: 1.4em 0 0.65em;
		line-height: 1.3;
	}

	.prose :global(h1:first-child),
	.prose :global(h2:first-child),
	.prose :global(h3:first-child) {
		margin-top: 0;
	}

	.prose :global(p),
	.prose :global(ul),
	.prose :global(ol),
	.prose :global(blockquote),
	.prose :global(pre),
	.prose :global(table) {
		margin: 0.8rem 0;
	}

	.prose :global(a) {
		color: var(--brand-strong);
		text-decoration-thickness: 1px;
		text-underline-offset: 0.18em;
	}

	.prose :global(blockquote) {
		padding: 0.15rem 0 0.15rem 0.9rem;
		border-left: 3px solid var(--brand);
		color: var(--text-secondary);
	}

	.prose :global(code) {
		padding: 0.12rem 0.32rem;
		border-radius: 0.35rem;
		background: var(--surface-subtle);
		font-family: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
		font-size: 0.86em;
	}

	.prose :global(pre) {
		overflow: auto;
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		background: #f8fafc;
	}

	.prose :global(pre code) {
		padding: 0;
		background: transparent;
	}

	.prose :global(table) {
		width: 100%;
		border-collapse: collapse;
	}

	.prose :global(th),
	.prose :global(td) {
		padding: 0.55rem;
		border: 1px solid var(--border);
		text-align: left;
	}

	.prose :global(th) {
		background: var(--surface-subtle);
	}
</style>
