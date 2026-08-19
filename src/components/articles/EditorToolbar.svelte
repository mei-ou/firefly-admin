<script lang="ts">
import {
	type BlockMarkdownCommand,
	type HeadingMarkdownCommand,
	type InlineMarkdownCommand,
} from "./editor-commands";
import {
	getToolbarCommands,
	TOOLBAR_GROUP_LABELS,
	type ToolbarCommandDefinition,
	type ToolbarCommandGroup,
} from "./toolbar-registry";

interface Props {
	disabled?: boolean;
	specialDisabled?: boolean;
	showLink?: boolean;
	showImage?: boolean;
	oninline: (command: InlineMarkdownCommand) => void;
	onblock: (command: BlockMarkdownCommand) => void;
	onlink: () => void;
	onimage: () => void;
	onheading: (command: "paragraph" | HeadingMarkdownCommand) => void;
	onundo: () => void;
	onredo: () => void;
	onspecial: () => void;
}

let {
	disabled = false,
	specialDisabled = false,
	showLink = true,
	showImage = true,
	oninline,
	onblock,
	onlink,
	onimage,
	onheading,
	onundo,
	onredo,
	onspecial,
}: Props = $props();

const groups: ToolbarCommandGroup[] = ["inline", "block", "insert"];

function executeCommand(command: ToolbarCommandDefinition): void {
	if (command.group === "inline") {
		oninline(command.id as InlineMarkdownCommand);
		return;
	}
	if (command.id === "link") {
		onlink();
		return;
	}
	if (command.id === "image") {
		onimage();
		return;
	}
	onblock(command.id as BlockMarkdownCommand);
}
</script>

<div class="editor-toolbar" role="toolbar" aria-label="文章排版工具栏">
	<div class="tool-group leading-tools" aria-label="段落和历史记录">
		<label class="heading-picker">
			<span>段落样式</span>
			<select
				disabled={disabled}
				aria-label="段落样式"
				onchange={(event) =>
					onheading(
						event.currentTarget.value as "paragraph" | HeadingMarkdownCommand,
					)}
			>
				<option value="paragraph">正文</option>
				<option value="heading-1">H1 标题</option>
				<option value="heading-2">H2 标题</option>
				<option value="heading-3">H3 标题</option>
				<option value="heading-4">H4 标题</option>
				<option value="heading-5">H5 标题</option>
				<option value="heading-6">H6 标题</option>
			</select>
		</label>
		<button type="button" title="撤销" aria-label="撤销" disabled={disabled} onclick={onundo}>↶</button>
		<button type="button" title="重做" aria-label="重做" disabled={disabled} onclick={onredo}>↷</button>
	</div>
	{#each groups as group}
		<div class="tool-group" aria-label={TOOLBAR_GROUP_LABELS[group]}>
			{#each getToolbarCommands(group) as command (command.id)}
				{#if (command.id !== "link" || showLink) && (command.id !== "image" || showImage)}
					<button
						class:low-priority={command.compact === false}
						type="button"
						title={command.shortcut ? `${command.label}（${command.shortcut}）` : command.label}
						aria-label={command.label}
						disabled={disabled}
						onclick={() => executeCommand(command)}
					>
						{#if command.id === "bold"}<strong>{command.content}</strong>
						{:else if command.id === "italic"}<em>{command.content}</em>
						{:else if command.id === "strikethrough"}<s>{command.content}</s>
						{:else if command.id === "inline-code"}<code>{command.content}</code>
						{:else}{command.content}{/if}
					</button>
				{/if}
			{/each}
		</div>
	{/each}
	<button class="special-tool" type="button" title="插入特殊块" aria-label="插入特殊块" disabled={specialDisabled} onclick={onspecial}>＋ 特殊块</button>
</div>

<style>
	.editor-toolbar {
		position: sticky;
		top: 0.5rem;
		z-index: 3;
		display: flex;
		align-items: center;
		gap: 0.35rem;
		overflow-x: auto;
		padding: 0.45rem;
		border: 1px solid var(--border);
		border-radius: 0.75rem;
		background: rgba(255, 255, 255, 0.96);
		box-shadow: var(--shadow-sm);
		backdrop-filter: blur(12px);
		scrollbar-width: thin;
	}

	.tool-group {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		padding-right: 0.35rem;
		border-right: 1px solid var(--border);
		flex: none;
	}

	.tool-group:last-child { border-right: 0; }
	.leading-tools { margin-right: 0.1rem; }
	.tool-group label { margin: 0; }
	.tool-group label span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

	button, select {
		min-height: 2rem;
		border: 0;
		border-radius: 0.45rem;
		background: transparent;
		color: var(--text-secondary);
		font: inherit;
		font-size: 0.74rem;
		font-weight: 700;
		white-space: nowrap;
	}

	button { min-width: 2rem; padding: 0.35rem 0.5rem; cursor: pointer; }
	select { padding: 0.3rem 1.7rem 0.3rem 0.45rem; cursor: pointer; }
	.heading-picker select { max-width: 7.5rem; border: 1px solid var(--border); background: white; }
	.special-tool { min-width: auto; background: #f5f3ff; color: #6d28d9; }
	button:hover:not(:disabled), select:hover:not(:disabled) { background: var(--brand-soft); color: var(--brand-strong); }
	button:focus-visible, select:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
	button:disabled, select:disabled { cursor: not-allowed; opacity: 0.45; }
	mark { padding: 0.05rem 0.18rem; border-radius: 0.2rem; background: #fef08a; }

	@media (max-width: 680px) {
		.editor-toolbar { top: 0.25rem; border-radius: 0; padding-inline: 0.55rem; }
		.tool-group button { min-width: 2.15rem; }
		.tool-group button.low-priority { display: none; }
	}
</style>
