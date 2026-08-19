<script lang="ts">
interface Props {
	title: string;
	description: string;
	status?: "ready" | "planned";
}

let { title, description, status = "planned" }: Props = $props();
</script>

<article class="status-panel">
	<div class="status-icon" class:ready={status === "ready"} aria-hidden="true"></div>
	<div>
		<div class="status-heading">
			<h2>{title}</h2>
			<span>{status === "ready" ? "安全外壳就绪" : "P0 占位"}</span>
		</div>
		<p>{description}</p>
	</div>
</article>

<style>
	.status-panel {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.85rem;
		padding: 1.1rem;
		border: 1px solid var(--border);
		border-radius: 1rem;
		background: var(--surface);
		box-shadow: var(--shadow-sm);
	}

	.status-icon {
		width: 0.65rem;
		height: 0.65rem;
		margin-top: 0.45rem;
		border-radius: 999px;
		background: var(--warning);
		box-shadow: 0 0 0 4px var(--warning-soft);
	}

	.status-icon.ready {
		background: var(--success);
		box-shadow: 0 0 0 4px var(--success-soft);
	}

	.status-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	h2 {
		margin: 0;
		font-size: 1rem;
	}

	span {
		color: var(--text-muted);
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	p {
		margin: 0.35rem 0 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.55;
	}
</style>
