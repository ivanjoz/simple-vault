<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import Button from './Button.svelte';

	let {
		open = false,
		onclose,
		page = 'vault',
		onexitpage
	}: {
		open?: boolean;
		onclose?: () => void;
		page?: 'vault' | 'restore' | 'backups';
		onexitpage?: () => void;
	} = $props();

	let newFolder = $state('');
	let countdownNow = $state(Date.now());

	const syncTimeFormatter = new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
	const nextSyncSeconds = $derived(
		vault.nextAutoSyncAt === null
			? null
			: Math.max(0, Math.ceil((vault.nextAutoSyncAt - countdownNow) / 1_000))
	);

	// Restart the one-second UI clock whenever a new debounce deadline is set.
	$effect(() => {
		const nextAutoSyncAt = vault.nextAutoSyncAt;
		countdownNow = Date.now();
		if (nextAutoSyncAt === null) return;
		const timer = setInterval(() => (countdownNow = Date.now()), 1_000);
		return () => clearInterval(timer);
	});

	async function addFolder() {
		const name = newFolder.trim();
		if (!name) return;
		await vault.addFolder(name);
		newFolder = '';
	}

	function selectFolder(id: string | null) {
		vault.selectedFolderId = id;
		if (page !== 'vault') onexitpage?.();
		onclose?.();
	}
</script>

<!-- Backdrop: mobile only, shown while the drawer is open. -->
{#if open}
	<div
		class="fixed inset-0 z-40 bg-black/60 md:hidden"
		onclick={() => onclose?.()}
		onkeydown={() => {}}
		role="presentation"
	></div>
{/if}

<aside
	class="fixed inset-y-0 left-0 z-50 flex w-240 shrink-0 flex-col border-r border-border bg-surface transition-transform duration-200 ease-out md:relative md:z-auto md:translate-x-0 md:transition-none {open
		? 'translate-x-0'
		: '-translate-x-full'}"
>
	<div class="flex items-center justify-between gap-8 px-16 py-16">
		<div class="flex items-center gap-8">
			<img src="/icon-192.png" alt="Vault logo" class="h-24 w-24" />
			<span class="font-semibold">Vault</span>
		</div>
		<button
			type="button"
			aria-label="Settings"
			title="Settings"
			onclick={() => {
				vault.settingsOpen = true;
				onclose?.();
			}}
			class="flex h-32 w-32 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
		>
			<span class="icon-[lucide--settings] text-[20px]"></span>
		</button>
	</div>

	<nav class="flex-1 overflow-y-auto px-8">
		{#if page !== 'vault'}
			<div class="mb-4 flex w-full items-center gap-8 rounded-lg bg-surface-2 px-12 py-8 text-sm text-text">
				{#if page === 'restore'}
					<span class="icon-[lucide--archive-restore] shrink-0 text-[16px] text-accent"></span>
				{:else}
					<span class="icon-[lucide--list] shrink-0 text-[16px] text-accent"></span>
				{/if}
				<span class="min-w-0 flex-1 truncate">{page === 'restore' ? 'Restore' : 'Manage Backups'}</span>
				<button
					type="button"
					aria-label="Close {page === 'restore' ? 'Restore' : 'Manage Backups'}"
					title="Close {page === 'restore' ? 'Restore' : 'Manage Backups'}"
					onclick={() => {
						onexitpage?.();
						onclose?.();
					}}
					class="flex h-24 w-24 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-border hover:text-text"
				>
					<span class="icon-[lucide--x] text-[16px]"></span>
				</button>
			</div>
		{/if}

		<button
			class="mb-4 w-full rounded-lg px-12 py-8 text-left text-sm transition-colors hover:bg-surface-2 {vault.selectedFolderId ===
			null
				? 'bg-surface-2 text-text'
				: 'text-muted'}"
			onclick={() => selectFolder(null)}
		>
			All items
			<span class="float-right text-xs text-muted">{vault.cards.length}</span>
		</button>

		{#each vault.folders as folder (folder.id)}
			<button
				class="mb-4 w-full truncate rounded-lg px-12 py-8 text-left text-sm transition-colors hover:bg-surface-2 {vault.selectedFolderId ===
				folder.id
					? 'bg-surface-2 text-text'
					: 'text-muted'}"
				onclick={() => selectFolder(folder.id)}
			>
				{folder.name}
				<span class="float-right text-xs text-muted">
					{vault.cards.filter((c) => c.folderId === folder.id).length}
				</span>
			</button>
		{/each}
	</nav>

	<div class="border-t border-border p-12">
		<div class="flex gap-8">
			<input
				bind:value={newFolder}
				placeholder="New folder"
				onkeydown={(e) => e.key === 'Enter' && addFolder()}
				class="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-8 py-6 text-sm outline-none focus:border-accent"
			/>
			<Button variant="ghost" onclick={addFolder}>+</Button>
		</div>
	</div>

	<div class="border-t border-border p-12">
		<div class="flex gap-8">
			<Button
				variant="ghost"
				size="sm"
				full
				class="min-w-0"
				disabled={vault.syncing}
				onclick={() => vault.syncNow()}
			>
				<span
					class="icon-[lucide--refresh-cw] shrink-0 text-[16px] {vault.syncing
						? 'animate-spin'
						: ''}"
				></span>
				<span class="truncate">
					{#if vault.syncing}
						Syncing…
					{:else if vault.driveConnected}
						Sync
					{:else}
						Connect
					{/if}
				</span>
			</Button>
			<Button variant="ghost" size="sm" full class="min-w-0" onclick={() => vault.lock()}>
				<span class="icon-[lucide--lock] shrink-0 text-[16px]"></span>
				<span class="truncate">Lock</span>
			</Button>
		</div>
		{#if vault.lastSync || nextSyncSeconds !== null}
			<div class="mt-8 flex items-center justify-between gap-8 px-4 text-xs text-muted">
				{#if vault.lastSync}
					<span>Synced {syncTimeFormatter.format(vault.lastSync)}</span>
				{:else}
					<span></span>
				{/if}
				{#if nextSyncSeconds !== null}
					<span class="shrink-0 text-accent">Next in {nextSyncSeconds}s</span>
				{/if}
			</div>
		{/if}
	</div>
</aside>
