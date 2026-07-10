<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import type { CardView } from '$lib/vault/types';
	import Sidebar from './Sidebar.svelte';
	import Card from './Card.svelte';
	import RecordDialog from './RecordDialog.svelte';
	import Settings from './Settings.svelte';
	import Button from './Button.svelte';

	// undefined = closed, null = new item, CardView = editing that item.
	let editing = $state<CardView | null | undefined>(undefined);

	function openNew() {
		editing = null;
	}
	function openCard(card: CardView) {
		editing = card;
	}
	function close() {
		editing = undefined;
	}
</script>

<div class="flex h-screen overflow-hidden">
	<Sidebar />

	<main class="flex flex-1 flex-col overflow-hidden">
		<div class="flex items-center gap-3 border-b border-border p-4">
			<div class="relative flex-1">
				<svg
					class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
				>
					<circle cx="11" cy="11" r="8" />
					<path d="m21 21-4.3-4.3" />
				</svg>
				<input
					bind:value={vault.search}
					placeholder="Search items…"
					class="w-full rounded-lg border border-border bg-surface-2 py-2 pr-3 pl-9 text-sm text-text outline-none focus:border-accent"
				/>
			</div>
			<Button onclick={openNew}>New item</Button>
		</div>

		<div class="flex-1 overflow-y-auto p-4">
			{#if vault.visibleCards.length === 0}
				<div class="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
					<p>{vault.cards.length === 0 ? 'Your vault is empty.' : 'No items match your search.'}</p>
					{#if vault.cards.length === 0}
						<Button onclick={openNew}>Add your first item</Button>
					{/if}
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each vault.visibleCards as card (card.id)}
						<Card {card} onopen={openCard} />
					{/each}
				</div>
			{/if}
		</div>
	</main>
</div>

{#if editing !== undefined}
	<RecordDialog card={editing} onclose={close} />
{/if}

{#if vault.settingsOpen}
	<Settings onclose={() => (vault.settingsOpen = false)} />
{/if}
