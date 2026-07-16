<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import type { CardView } from '$lib/vault/types';
	import Sidebar from './Sidebar.svelte';
	import Card from './Card.svelte';
	import RecordDialog from './RecordDialog.svelte';
	import Settings from './Settings.svelte';
	import Button from './Button.svelte';
	import Notification from './Notification.svelte';
	import Restore from './Restore.svelte';

	// undefined = closed, null = new item, CardView = editing that item.
	let editing = $state<CardView | null | undefined>(undefined);

	// Mobile-only: whether the sidebar drawer is open.
	let sidebarOpen = $state(false);
	let page = $state<'vault' | 'restore'>('vault');

	function openNew() {
		editing = null;
	}
	function openCard(card: CardView) {
		editing = card;
	}
	function close() {
		editing = undefined;
	}
	function openRestore() {
		editing = undefined;
		vault.error = null;
		vault.settingsOpen = false;
		page = 'restore';
	}
	function closeRestore() {
		vault.error = null;
		page = 'vault';
	}
</script>

<div class="flex h-screen overflow-hidden">
	<Sidebar
		open={sidebarOpen}
		onclose={() => (sidebarOpen = false)}
		{page}
		onexitpage={closeRestore}
	/>

	<main class="flex min-w-0 flex-1 flex-col overflow-hidden">
		<!-- Static top bar, mobile only. Fixed height, contents vertically centered. -->
		<div class="flex h-56 shrink-0 items-center gap-12 border-b border-border px-12 md:hidden">
			<button
				type="button"
				aria-label="Open menu"
				title="Menu"
				onclick={() => (sidebarOpen = true)}
				class="flex h-36 w-36 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
			>
				<span class="icon-[lucide--menu] text-[22px]"></span>
			</button>
			<img src="/icon-192.png" alt="Vault logo" class="h-24 w-24" />
			<span class="font-semibold">Vault</span>
		</div>

		{#if page === 'restore'}
			<Restore onclose={closeRestore} />
		{:else}
		<div class="flex items-center gap-12 border-b border-border p-10">
			<div class="relative flex-1">
				<svg
					class="pointer-events-none absolute top-1/2 left-12 -translate-y-1/2 text-muted"
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
					class="w-full rounded-lg border border-border bg-surface-2 py-8 pr-12 pl-36 text-sm text-text outline-none focus:border-accent"
				/>
			</div>
			<Button onclick={openNew}>New item</Button>
		</div>

		<div class="flex-1 overflow-y-auto p-16">
			{#if vault.visibleCards.length === 0}
				<div class="flex h-full flex-col items-center justify-center gap-12 text-center text-muted">
					<p>{vault.cards.length === 0 ? 'Your vault is empty.' : 'No items match your search.'}</p>
					{#if vault.cards.length === 0}
						<Button onclick={openNew}>Add your first item</Button>
					{/if}
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-3">
					{#each vault.visibleCards as card (card.id)}
						<Card {card} onopen={openCard} />
					{/each}
				</div>
			{/if}
		</div>
		{/if}
	</main>
</div>

{#if editing !== undefined}
	<RecordDialog card={editing} onclose={close} />
{/if}

{#if vault.settingsOpen}
	<Settings onclose={() => (vault.settingsOpen = false)} onrestore={openRestore} />
{/if}

{#if vault.syncError}
	<Notification
		title="Sync failed"
		message={vault.syncError}
		variant="error"
		actionLabel={vault.recoverableDriveFile
			? vault.syncing
				? 'Replacing…'
				: 'Replace Drive file with local data'
			: undefined}
		actionDisabled={vault.syncing}
		onaction={vault.recoverableDriveFile
			? () => vault.replaceDriveFileWithLocalData()
			: undefined}
		ondismiss={() => {
			vault.syncError = null;
			vault.recoverableDriveFile = null;
		}}
	/>
{/if}
