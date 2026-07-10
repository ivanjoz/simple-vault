<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import Button from './Button.svelte';

	let newFolder = $state('');

	async function addFolder() {
		const name = newFolder.trim();
		if (!name) return;
		await vault.addFolder(name);
		newFolder = '';
	}
</script>

<aside class="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
	<div class="flex items-center gap-2 px-4 py-4">
		<div class="h-6 w-6 rounded-md bg-accent"></div>
		<span class="font-semibold">Simple Vault</span>
	</div>

	<nav class="flex-1 overflow-y-auto px-2">
		<button
			class="mb-1 w-full rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 {vault.selectedFolderId ===
			null
				? 'bg-surface-2 text-text'
				: 'text-muted'}"
			onclick={() => (vault.selectedFolderId = null)}
		>
			All items
			<span class="float-right text-xs text-muted">{vault.cards.length}</span>
		</button>

		{#each vault.folders as folder (folder.id)}
			<button
				class="mb-1 w-full truncate rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 {vault.selectedFolderId ===
				folder.id
					? 'bg-surface-2 text-text'
					: 'text-muted'}"
				onclick={() => (vault.selectedFolderId = folder.id)}
			>
				{folder.name}
				<span class="float-right text-xs text-muted">
					{vault.cards.filter((c) => c.folderId === folder.id).length}
				</span>
			</button>
		{/each}
	</nav>

	<div class="border-t border-border p-3">
		<div class="flex gap-2">
			<input
				bind:value={newFolder}
				placeholder="New folder"
				onkeydown={(e) => e.key === 'Enter' && addFolder()}
				class="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
			/>
			<Button variant="ghost" onclick={addFolder}>+</Button>
		</div>
	</div>

	<div class="border-t border-border p-3">
		<Button variant="ghost" full disabled={vault.syncing} onclick={() => vault.syncNow()}>
			{#if vault.syncing}
				Syncing…
			{:else if vault.driveConnected}
				Sync now
			{:else}
				Connect Drive
			{/if}
		</Button>
		{#if vault.syncError}
			<p class="mt-2 px-1 text-xs text-danger">{vault.syncError}</p>
		{:else if vault.lastSync}
			<p class="mt-2 px-1 text-xs text-muted">
				Synced {new Date(vault.lastSync).toLocaleTimeString()}
			</p>
		{/if}
	</div>

	<div class="flex gap-2 border-t border-border p-3">
		<Button variant="ghost" full onclick={() => (vault.settingsOpen = true)}>Settings</Button>
		<Button variant="ghost" full onclick={() => vault.lock()}>Lock</Button>
	</div>
</aside>
