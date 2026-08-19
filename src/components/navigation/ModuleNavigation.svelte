<script lang="ts">
import type { AdminModule } from "../../types/module";

interface Props {
	modules: AdminModule[];
	currentPath: string;
}

let { modules, currentPath }: Props = $props();
</script>

<nav aria-label="主导航">
	<ul>
		{#each modules as module (module.id)}
			<li>
				{#if module.externalUrl !== undefined}
					{@const isConfigured = module.externalUrl.length > 0}
					{#if isConfigured}
						<a
							class="external"
							href={module.externalUrl}
							target="_blank"
							rel="noopener noreferrer"
							title={module.navigation.description}
						>
							<span class="nav-icon" aria-hidden="true">{module.navigation.label.slice(0, 1)}</span>
							<span>{module.navigation.label}</span>
						</a>
					{:else}
						<!--
							外部服务已声明但 URL 未配置：保留入口提示运维，但不渲染 href 以避免
							被外部脚本/扩展意外激活；aria-disabled 让屏幕阅读器识别为不可用链接。
						-->
						<span
							class="disabled"
							role="link"
							aria-disabled="true"
							title={module.navigation.description}
						>
							<span class="nav-icon" aria-hidden="true">{module.navigation.label.slice(0, 1)}</span>
							<span>{module.navigation.label}</span>
						</span>
					{/if}
				{:else}
					<a
						class:active={currentPath === module.routes[0]?.path ||
							(module.routes[0]?.path !== "/" && currentPath.startsWith(module.routes[0]?.path ?? ""))}
						href={module.routes[0]?.path ?? "/"}
					>
						<span class="nav-icon" aria-hidden="true">{module.navigation.label.slice(0, 1)}</span>
						<span>{module.navigation.label}</span>
					</a>
				{/if}
			</li>
		{/each}
	</ul>
</nav>

<style>
	ul {
		display: grid;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	a,
	span.disabled {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.7rem 0.8rem;
		border-radius: 0.75rem;
		color: var(--text-secondary);
		font-size: 0.9rem;
		font-weight: 650;
		text-decoration: none;
		transition: background 150ms ease, color 150ms ease;
	}

	a:hover,
	a.active {
		background: var(--brand-soft);
		color: var(--brand-strong);
	}

	/* 外部服务已声明但 URL 未配置：保留入口提示但禁用点击，避免暴露为开放重定向。 */
	span.disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	/* 外链菜单项右侧附加箭头，视觉提示"点击会打开新窗口"。 */
	a.external::after {
		content: "↗";
		margin-left: auto;
		font-size: 0.75rem;
		opacity: 0.6;
	}

	.nav-icon {
		display: grid;
		width: 1.75rem;
		height: 1.75rem;
		place-items: center;
		border: 1px solid var(--border);
		border-radius: 0.55rem;
		background: white;
		font-size: 0.7rem;
	}
</style>