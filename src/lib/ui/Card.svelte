<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import type { CardView } from '$lib/vault/types';

	let { card, onopen }: { card: CardView; onopen: (card: CardView) => void } = $props();

	const copied = $derived(vault.copiedId === card.id);

	function copy(e: MouseEvent) {
		e.stopPropagation();
		void vault.copyPassword(card.id);
	}

	function open(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') onopen(card);
	}
</script>

<div
	role="button"
	tabindex="0"
	onclick={() => onopen(card)}
	onkeydown={open}
	class="flex cursor-pointer flex-col gap-3 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"
>
	<div class="min-w-0">
		<div class="truncate font-medium text-text">{card.title || 'Untitled'}</div>
		<div class="truncate text-sm text-muted">{card.username || '—'}</div>
	</div>

	<div class="flex items-center justify-between">
		<span class="font-mono text-lg tracking-widest text-muted select-none">••••••••</span>
		<button
			onclick={copy}
			title="Copy password"
			class="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors {copied
				? 'text-success'
				: 'text-muted hover:bg-surface-2 hover:text-text'}"
		>
			{#if copied}
				Copied
			{:else}
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="9" y="9" width="13" height="13" rx="2" />
					<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
				</svg>
				Copy
			{/if}
		</button>
	</div>
</div>
