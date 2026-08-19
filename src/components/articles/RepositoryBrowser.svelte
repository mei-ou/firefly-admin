<script lang="ts">
import { onDestroy } from "svelte";
import {
	isImageRepositoryEntry,
	parseRepositoryDirectoryPayload,
	type RepositoryDirectory,
	type RepositoryEntry,
} from "./repository-directory";

interface Props {
	open: boolean;
	initialPath?: string;
	selectImagesOnly?: boolean;
	onclose: () => void;
	onselect: (entry: RepositoryEntry) => void;
}

let { open, initialPath = "", selectImagesOnly = false, onclose, onselect }: Props = $props();
let directory = $state<RepositoryDirectory | null>(null);
let loading = $state(false);
let errorMessage = $state("");
let previousOpen = false;
let requestController: AbortController | undefined;
let requestSequence = 0;

$effect(() => {
	if (open && !previousOpen) void loadDirectory(initialPath);
	previousOpen = open;
});

onDestroy(() => requestController?.abort());

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function loadDirectory(path: string): Promise<void> {
	const sequence = ++requestSequence;
	requestController?.abort();
	requestController = new AbortController();
	loading = true;
	errorMessage = "";
	try {
		const parameters = new URLSearchParams();
		if (path) parameters.set("path", path);
		const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
		const response = await fetch(`/api/repository/tree${suffix}`, {
			headers: { Accept: "application/json" },
			signal: requestController.signal,
		});
		const body = await readJson(response);
		if (!response.ok) throw new Error("仓库目录暂时无法加载。");
		const parsed = parseRepositoryDirectoryPayload(body);
		if (sequence === requestSequence) directory = parsed;
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") return;
		if (sequence !== requestSequence) return;
		errorMessage = error instanceof Error ? error.message : "仓库目录暂时无法加载。";
	} finally {
		if (sequence === requestSequence) loading = false;
	}
}

function chooseEntry(entry: RepositoryEntry): void {
	if (entry.type === "directory") {
		void loadDirectory(entry.path);
		return;
	}
	if (selectImagesOnly && !isImageRepositoryEntry(entry)) return;
	onselect(entry);
}
</script>

{#if open}
	<div class="drawer-backdrop" role="presentation" onclick={(event) => event.target === event.currentTarget && onclose()}>
		<aside class="repository-drawer" role="dialog" aria-modal="true" aria-labelledby="repository-browser-title">
			<header>
				<div><p class="eyebrow">Repository</p><h3 id="repository-browser-title">选择仓库文件</h3></div>
				<button class="icon-button" type="button" aria-label="关闭" onclick={onclose}>×</button>
			</header>
			<div class="path-bar">
				<button type="button" onclick={() => void loadDirectory("")}>仓库根目录</button>
				<span>/ {directory?.path ?? initialPath}</span>
			</div>
			{#if directory?.parentPath !== null && directory}
				<button class="parent-button" type="button" onclick={() => void loadDirectory(directory?.parentPath ?? "")}>← 返回上一级</button>
			{/if}
			<div class="entry-list" aria-busy={loading}>
				{#if loading}<p class="status-card">正在加载目录…</p>
				{:else if errorMessage}<p class="error-card" role="alert">{errorMessage}</p>
				{:else if !directory || directory.entries.length === 0}<p class="status-card">该目录为空。</p>
				{:else}
					{#each directory.entries as entry (entry.path)}
						<button
							class:disabled-file={selectImagesOnly && entry.type === "file" && !isImageRepositoryEntry(entry)}
							type="button"
							disabled={selectImagesOnly && entry.type === "file" && !isImageRepositoryEntry(entry)}
							onclick={() => chooseEntry(entry)}
						>
							<span class="entry-icon">{entry.type === "directory" ? "目录" : "文件"}</span>
							<strong>{entry.name}</strong>
							<small>{entry.type === "directory" ? "打开" : selectImagesOnly ? "选择图片" : "选择文件"}</small>
						</button>
					{/each}
				{/if}
			</div>
			<p class="boundary-note">仓库和分支由服务端固定；此处只按需读取目录，不会暴露访问凭据。</p>
		</aside>
	</div>
{/if}

<style>
	.drawer-backdrop { position: fixed; inset: 0; z-index: 40; background: rgba(15, 23, 42, 0.34); }
	.repository-drawer { position: absolute; inset: 0 0 0 auto; width: min(440px, 100%); padding: 1rem; overflow: auto; border-left: 1px solid var(--border); background: white; box-shadow: -20px 0 60px rgba(15, 23, 42, 0.18); }
	header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	header h3 { margin: 0.15rem 0 0; font-size: 1.12rem; }
	.eyebrow { margin: 0; color: var(--brand-strong); font-size: 0.66rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
	.icon-button { width: 2rem; height: 2rem; border: 0; border-radius: 999px; background: var(--surface-subtle); color: var(--text-secondary); font-size: 1.3rem; cursor: pointer; }
	.path-bar { display: flex; gap: 0.45rem; align-items: center; margin: 1rem 0 0.55rem; padding: 0.6rem; overflow: hidden; border: 1px solid var(--border); border-radius: 0.65rem; background: var(--surface-subtle); color: var(--text-muted); font-size: 0.72rem; }
	.path-bar button, .parent-button { border: 0; background: transparent; color: var(--brand-strong); font: inherit; font-weight: 750; cursor: pointer; }
	.path-bar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.parent-button { margin-bottom: 0.45rem; padding: 0.35rem; }
	.entry-list { display: grid; gap: 0.4rem; }
	.entry-list > button { display: grid; grid-template-columns: auto 1fr auto; gap: 0.55rem; align-items: center; padding: 0.72rem; border: 1px solid var(--border); border-radius: 0.65rem; background: white; color: var(--text-primary); font: inherit; text-align: left; cursor: pointer; }
	.entry-list > button:hover { border-color: var(--brand); background: var(--brand-soft); }
	.entry-list > button.disabled-file { opacity: 0.45; cursor: not-allowed; }
	.entry-icon { padding: 0.2rem 0.35rem; border-radius: 0.35rem; background: var(--surface-subtle); color: var(--text-muted); font-size: 0.62rem; font-weight: 800; }
	.entry-list small { color: var(--text-muted); font-size: 0.68rem; }
	.status-card, .error-card { margin: 0; padding: 0.8rem; border: 1px dashed var(--border); border-radius: 0.65rem; background: var(--surface-subtle); color: var(--text-muted); font-size: 0.75rem; }
	.error-card { color: #b91c1c; }
	.boundary-note { margin: 0.8rem 0 0; color: var(--text-muted); font-size: 0.7rem; line-height: 1.5; }
</style>
