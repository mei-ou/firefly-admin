<script lang="ts">
import {
	type ArticleListPayload,
	buildArticleListApiUrl,
	DEFAULT_ARTICLE_LIST_SEARCH,
	formatArticleDate,
	parseArticleListError,
	parseArticleListPayload,
} from "./article-list-state";

let articles = $state<ArticleListPayload | null>(null);
let loading = $state(true);
let errorMessage = $state("");
let queryInput = $state("");
let appliedQuery = $state(DEFAULT_ARTICLE_LIST_SEARCH.query);
let page = $state(DEFAULT_ARTICLE_LIST_SEARCH.page);
let requestSequence = 0;

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function loadArticles(targetPage = page): Promise<void> {
	const sequence = ++requestSequence;
	loading = true;
	errorMessage = "";
	try {
		const response = await fetch(
			buildArticleListApiUrl({
				page: targetPage,
				pageSize: DEFAULT_ARTICLE_LIST_SEARCH.pageSize,
				query: appliedQuery,
			}),
			{ headers: { Accept: "application/json" } },
		);
		const body = await readJson(response);
		if (!response.ok) {
			throw new Error(parseArticleListError(body, response.status));
		}
		const nextArticles = parseArticleListPayload(body);
		if (sequence === requestSequence) {
			articles = nextArticles;
			page = nextArticles.page;
		}
	} catch (error) {
		if (sequence === requestSequence) {
			errorMessage = error instanceof Error ? error.message : "文章列表暂时无法加载，请稍后重试。";
			articles = null;
		}
	} finally {
		if (sequence === requestSequence) {
			loading = false;
		}
	}
}

function applySearch(event: SubmitEvent): void {
	event.preventDefault();
	appliedQuery = queryInput.trim();
	page = 1;
	void loadArticles(1);
}

function resetSearch(): void {
	queryInput = "";
	appliedQuery = "";
	page = 1;
	void loadArticles(1);
}

function goToPage(targetPage: number): void {
	if (loading || targetPage < 1 || targetPage > (articles?.totalPages ?? 0)) {
		return;
	}
	page = targetPage;
	void loadArticles(targetPage);
}

$effect(() => {
	void loadArticles(1);
});
</script>

<section class="article-workspace" aria-busy={loading}>
	<header class="workspace-header">
		<div>
			<p class="eyebrow">Content workspace</p>
			<h2>管理文章</h2>
			<p>从受保护的 GitHub 内容目录读取文章。单次请求最多扫描 100 篇。</p>
		</div>
		<a class="primary-action" href="/articles/new">新建文章</a>
	</header>

	<form class="toolbar" onsubmit={applySearch} role="search">
		<label for="article-query">搜索文章</label>
		<div class="search-row">
			<input
				id="article-query"
				bind:value={queryInput}
				maxlength="100"
				placeholder="搜索标题、标签、分类或 slug"
				type="search"
			/>
			<button class="search-button" type="submit" disabled={loading}>搜索</button>
			{#if appliedQuery}
				<button class="secondary-button" type="button" onclick={resetSearch} disabled={loading}>清除</button>
			{/if}
		</div>
	</form>

	{#if errorMessage}
		<div class="message error-message" role="alert">
			<div><strong>加载失败</strong><p>{errorMessage}</p></div>
			<button type="button" onclick={() => loadArticles(page)}>重试</button>
		</div>
	{:else if loading && articles === null}
		<div class="loading-list" aria-label="正在加载文章">
			{#each Array.from({ length: 4 }) as _, index (index)}
				<div class="skeleton-row"><span></span><span></span></div>
			{/each}
		</div>
	{:else if articles}
		<div class="summary-row" aria-live="polite">
			<span>共 <strong>{articles.total}</strong> 篇匹配文章</span>
			<span>已扫描 {articles.scanned} 个目录{articles.skipped > 0 ? `，跳过 ${articles.skipped} 篇异常文章` : ""}</span>
		</div>

		{#if articles.truncated}
			<div class="message warning-message" role="status">
				<strong>扫描结果已截断</strong>
				<p>仓库中有 {articles.candidateCount} 个候选目录，本次仅扫描前 {articles.scanned} 个。搜索结果可能不完整。</p>
			</div>
		{/if}

		{#if articles.items.length === 0}
			<div class="empty-list">
				<strong>{appliedQuery ? "没有找到匹配文章" : "仓库中还没有可管理的文章"}</strong>
				<p>{appliedQuery ? "请尝试更短的关键词，或清除搜索条件。" : "新建第一篇文章后，它会显示在这里。"}</p>
				{#if appliedQuery}<button type="button" onclick={resetSearch}>清除搜索</button>{/if}
			</div>
		{:else}
			<div class="article-list">
				{#each articles.items as article (article.storageSlug)}
					<article class="article-row">
						<div class="article-main">
							<div class="title-row">
								<a href={`/articles/${article.storageSlug}`}>{article.title}</a>
								{#if article.pinned}<span class="badge pinned">置顶</span>{/if}
								<span class:published={!article.draft} class:draft={article.draft} class="badge">
									{article.draft ? "草稿" : "已发布"}
								</span>
							</div>
							<p>{article.description || "暂无描述"}</p>
							<div class="metadata">
								<span>{formatArticleDate(article.published)}</span>
								<span>{article.category ?? "未分类"}</span>
								<span>/{article.slug ?? article.storageSlug}</span>
							</div>
							{#if article.tags.length > 0}
								<div class="tags" aria-label="文章标签">
									{#each article.tags.slice(0, 4) as tag (tag)}<span>{tag}</span>{/each}
								</div>
							{/if}
						</div>
						<a class="edit-link" href={`/articles/${article.storageSlug}`}>编辑</a>
					</article>
				{/each}
			</div>
		{/if}

		{#if articles.totalPages > 1}
			<nav class="pagination" aria-label="文章分页">
				<button type="button" disabled={loading || page <= 1} onclick={() => goToPage(page - 1)}>上一页</button>
				<span>第 {page} / {articles.totalPages} 页</span>
				<button type="button" disabled={loading || page >= articles.totalPages} onclick={() => goToPage(page + 1)}>下一页</button>
			</nav>
		{/if}
	{/if}
</section>

<style>
	.article-workspace { display: grid; gap: 1rem; }
	.workspace-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; }
	.workspace-header h2 { margin: 0; font-size: clamp(1.55rem, 3vw, 2.25rem); letter-spacing: -0.035em; }
	.workspace-header p:not(.eyebrow) { max-width: 680px; margin: 0.55rem 0 0; color: var(--text-secondary); line-height: 1.65; }
	.primary-action, .search-button, .secondary-button, button { border: 0; font: inherit; cursor: pointer; }
	.primary-action { flex: none; padding: 0.72rem 1rem; border-radius: 0.75rem; background: var(--brand); color: white; font-weight: 750; text-decoration: none; }
	.primary-action:hover, .search-button:hover { background: var(--brand-strong); }
	.toolbar { padding: 1rem; border: 1px solid var(--border); border-radius: 1rem; background: var(--surface); box-shadow: var(--shadow-sm); }
	.toolbar label { display: block; margin-bottom: 0.55rem; color: var(--text-secondary); font-size: 0.78rem; font-weight: 750; }
	.search-row { display: flex; gap: 0.65rem; }
	input { min-width: 0; flex: 1; padding: 0.72rem 0.8rem; border: 1px solid var(--border); border-radius: 0.7rem; background: var(--surface); color: var(--text-primary); font: inherit; }
	input:focus { border-color: var(--brand); outline: 3px solid var(--brand-soft); }
	.search-button, .secondary-button, .pagination button, .message button, .empty-list button { padding: 0.68rem 0.9rem; border-radius: 0.68rem; font-weight: 700; }
	.search-button { background: var(--brand); color: white; }
	.secondary-button, .pagination button, .message button, .empty-list button { border: 1px solid var(--border); background: white; color: var(--text-secondary); }
	button:disabled { cursor: not-allowed; opacity: 0.55; }
	.summary-row { display: flex; justify-content: space-between; gap: 1rem; color: var(--text-muted); font-size: 0.8rem; }
	.summary-row strong { color: var(--text-primary); }
	.article-list, .loading-list { overflow: hidden; border: 1px solid var(--border); border-radius: 1rem; background: var(--surface); box-shadow: var(--shadow-sm); }
	.article-row { display: flex; align-items: center; justify-content: space-between; gap: 1.2rem; padding: 1.15rem; }
	.article-row + .article-row { border-top: 1px solid var(--border); }
	.article-main { min-width: 0; }
	.title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
	.title-row > a { color: var(--text-primary); font-size: 1rem; font-weight: 780; text-decoration: none; }
	.title-row > a:hover, .edit-link:hover { color: var(--brand-strong); }
	.article-main > p { overflow: hidden; margin: 0.45rem 0; color: var(--text-secondary); font-size: 0.88rem; text-overflow: ellipsis; white-space: nowrap; }
	.badge { padding: 0.2rem 0.42rem; border-radius: 999px; font-size: 0.66rem; font-weight: 800; }
	.badge.draft { background: var(--warning-soft); color: #9a4d05; }
	.badge.published { background: var(--success-soft); color: #147b39; }
	.badge.pinned { background: var(--brand-soft); color: var(--brand-strong); }
	.metadata, .tags { display: flex; flex-wrap: wrap; gap: 0.65rem; color: var(--text-muted); font-size: 0.75rem; }
	.tags { margin-top: 0.65rem; gap: 0.35rem; }
	.tags span { padding: 0.18rem 0.42rem; border-radius: 0.45rem; background: var(--surface-subtle); }
	.edit-link { flex: none; color: var(--brand); font-size: 0.82rem; font-weight: 750; text-decoration: none; }
	.message, .empty-list { padding: 1rem; border-radius: 0.9rem; }
	.message { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
	.message p, .empty-list p { margin: 0.25rem 0 0; font-size: 0.84rem; line-height: 1.5; }
	.error-message { border: 1px solid #fecaca; background: #fff7f7; color: #991b1b; }
	.warning-message { border: 1px solid #fde68a; background: #fffbeb; color: #854d0e; }
	.empty-list { padding-block: 3.5rem; border: 1px solid var(--border); background: var(--surface); color: var(--text-primary); text-align: center; box-shadow: var(--shadow-sm); }
	.empty-list p { color: var(--text-secondary); }
	.skeleton-row { display: grid; gap: 0.65rem; padding: 1.2rem; }
	.skeleton-row + .skeleton-row { border-top: 1px solid var(--border); }
	.skeleton-row span { height: 0.75rem; border-radius: 999px; background: linear-gradient(90deg, #edf0f5, #f8fafc, #edf0f5); }
	.skeleton-row span:first-child { width: min(320px, 60%); }
	.skeleton-row span:last-child { width: min(520px, 90%); }
	.pagination { display: flex; align-items: center; justify-content: flex-end; gap: 0.75rem; color: var(--text-secondary); font-size: 0.8rem; }
	@media (max-width: 680px) {
		.workspace-header, .summary-row, .message { align-items: stretch; flex-direction: column; }
		.primary-action { text-align: center; }
		.search-row { flex-wrap: wrap; }
		.search-row input { flex-basis: 100%; }
		.article-row { align-items: flex-start; }
		.article-main > p { white-space: normal; }
		.pagination { justify-content: space-between; }
	}
</style>
