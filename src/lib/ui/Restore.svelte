<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import type { Bytes } from '$lib/crypto';
	import { inspectBackup } from '$lib/vault/backup';
	import type { BackupManifest, BackupPreview } from '$lib/vault/backup';
	import Button from './Button.svelte';
	import TextField from './TextField.svelte';

	let { onclose }: { onclose: () => void } = $props();

	let fileInput = $state<HTMLInputElement | null>(null);
	let selectedFile = $state<File | null>(null);
	let backupBytes = $state<Bytes | null>(null);
	let manifest = $state<BackupManifest | null>(null);
	let preview = $state<BackupPreview | null>(null);
	let method = $state<'password' | 'recovery'>('password');
	let secret = $state('');
	let fileError = $state('');
	let restoring = $state(false);

	const activePreviewFolders = $derived(
		preview?.folders.filter((folder) => folder.status === 'active') ?? []
	);

	function resetPreview() {
		preview = null;
		secret = '';
		vault.error = null;
	}

	async function loadFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		selectedFile = file;
		backupBytes = null;
		manifest = null;
		fileError = '';
		resetPreview();
		try {
			const bytes = new Uint8Array(await file.arrayBuffer()) as Bytes;
			manifest = inspectBackup(bytes);
			backupBytes = bytes;
		} catch (error) {
			fileError = error instanceof Error ? error.message : String(error);
		}
	}

	async function inspectContents() {
		if (!backupBytes || !secret.trim()) return;
		preview = await vault.previewVaultBackup(backupBytes, secret, method);
		if (preview) secret = '';
	}

	async function restoreBackup() {
		if (!backupBytes || !preview || restoring) return;
		restoring = true;
		fileError = '';
		try {
			await vault.importVault(backupBytes);
		} catch (error) {
			fileError = error instanceof Error ? error.message : String(error);
			restoring = false;
		}
	}

	function formatDate(seconds: number): string {
		return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
			seconds * 1_000
		);
	}

	function formatSize(bytes: number): string {
		if (bytes < 1_024) return `${bytes} B`;
		if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
		return `${(bytes / 1_048_576).toFixed(1)} MB`;
	}

	function activeItemCount(folder: BackupPreview['folders'][number]): number {
		return folder.items.filter((item) => item.status === 'active').length;
	}

	function latestActiveItemUpdate(folder: BackupPreview['folders'][number]): number | null {
		const timestamps = folder.items
			.filter((item) => item.status === 'active')
			.map((item) => item.updated);
		return timestamps.length ? Math.max(...timestamps) : null;
	}
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
	<header class="flex h-56 shrink-0 items-center gap-8 border-b border-border px-12 md:px-20">
		<button
			type="button"
			aria-label="Back to vault"
			title="Back to vault"
			onclick={onclose}
			class="flex h-36 w-36 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"
		>
			<span class="icon-[lucide--arrow-left] text-[20px]"></span>
		</button>
		<h1 class="text-base font-semibold">Restore</h1>
	</header>

	<div class="flex-1 overflow-y-auto p-16 md:p-24">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-20">
			<div>
				<h2 class="text-xl font-semibold">Restore a backup</h2>
				<p class="mt-6 text-sm text-muted">
					Review the backup before replacing the vault stored on this device.
				</p>
			</div>

			<section class="rounded-xl border border-border bg-surface p-16 md:p-20">
				<div class="flex flex-wrap items-center justify-between gap-12">
					<div>
						<h3 class="text-sm font-medium">1. Choose a backup file</h3>
						<p class="mt-4 text-xs text-muted">Current Simple Vault <code>.svault</code> backups are supported.</p>
					</div>
					<Button variant="ghost" onclick={() => fileInput?.click()}>
						{selectedFile ? 'Choose another file' : 'Choose file'}
					</Button>
					<input
						bind:this={fileInput}
						type="file"
						accept="application/cbor,.svault"
						class="hidden"
						onchange={loadFile}
					/>
				</div>

				{#if selectedFile}
					<div class="mt-16 flex items-center gap-12 rounded-lg bg-surface-2 p-12">
						<span class="icon-[lucide--file-lock-2] shrink-0 text-[20px] text-accent"></span>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{selectedFile.name}</p>
							<p class="text-xs text-muted">{formatSize(selectedFile.size)}</p>
						</div>
					</div>
				{/if}

				{#if fileError}
					<p class="mt-12 text-sm text-danger">{fileError}</p>
				{/if}
			</section>

			{#if manifest}
				<section class="rounded-xl border border-border bg-surface p-16 md:p-20">
					<h3 class="text-sm font-medium">2. Encrypted inventory</h3>
					<p class="mt-4 text-xs text-muted">
						The file is valid. Only structural totals are available until the backup key is verified.
					</p>

					<div class="mt-16 grid grid-cols-2 gap-8 sm:grid-cols-4">
						<div class="rounded-lg bg-surface-2 p-12">
							<p class="text-lg font-semibold">v{manifest.format}</p>
							<p class="text-xs text-muted">Format</p>
						</div>
						<div class="rounded-lg bg-surface-2 p-12">
							<p class="text-lg font-semibold">{manifest.activeFolderCount}</p>
							<p class="text-xs text-muted">Folders</p>
						</div>
						<div class="rounded-lg bg-surface-2 p-12">
							<p class="text-lg font-semibold">{manifest.activeItemCount}</p>
							<p class="text-xs text-muted">Items</p>
						</div>
						<div class="rounded-lg bg-surface-2 p-12">
							<p class="truncate text-sm font-semibold">{formatDate(manifest.headerUpdated)}</p>
							<p class="text-xs text-muted">Backup updated</p>
						</div>
					</div>

				</section>

				<section class="rounded-xl border border-border bg-surface p-16 md:p-20">
					<h3 class="text-sm font-medium">3. Unlock the preview</h3>
					<p class="mt-4 text-xs text-muted">
						This only inspects the selected file. It does not change your open vault.
					</p>

					<div class="mt-16 flex gap-8" role="group" aria-label="Backup unlock method">
						<button
							type="button"
							onclick={() => {
								method = 'password';
								resetPreview();
							}}
							class="rounded-lg px-12 py-8 text-sm transition-colors {method === 'password' ? 'bg-accent text-black' : 'bg-surface-2 text-muted hover:text-text'}"
						>Master password</button>
						<button
							type="button"
							onclick={() => {
								method = 'recovery';
								resetPreview();
							}}
							class="rounded-lg px-12 py-8 text-sm transition-colors {method === 'recovery' ? 'bg-accent text-black' : 'bg-surface-2 text-muted hover:text-text'}"
						>Recovery key</button>
					</div>

					<div class="mt-12 flex flex-col gap-12 sm:flex-row sm:items-end">
						<div class="min-w-0 flex-1">
							<TextField
								label={method === 'password' ? 'Backup master password' : 'Backup recovery key'}
								type="password"
								autocomplete="off"
								bind:value={secret}
								onenter={inspectContents}
							/>
						</div>
						<Button disabled={!secret.trim() || vault.busy} onclick={inspectContents}>
							{vault.busy ? 'Inspecting…' : 'Inspect contents'}
						</Button>
					</div>
					{#if vault.error}<p class="mt-10 text-sm text-danger">{vault.error}</p>{/if}
				</section>
			{/if}

			{#if preview}
				<section class="rounded-xl border border-success/40 bg-surface p-16 md:p-20">
					<div class="flex items-start gap-10">
						<span class="icon-[lucide--circle-check] mt-1 shrink-0 text-[18px] text-success"></span>
						<div>
							<h3 class="text-sm font-medium">Backup contents verified</h3>
							<p class="mt-4 text-xs text-muted">Only folder summaries are shown in this preview.</p>
						</div>
					</div>

					<div class="mt-16 space-y-8">
						{#each activePreviewFolders as folder (folder.id)}
							{@const itemCount = activeItemCount(folder)}
							{@const lastUpdated = latestActiveItemUpdate(folder)}
							<div class="rounded-lg border border-border bg-surface-2 px-12 py-12">
								<div class="flex items-center justify-between gap-12">
									<div class="flex min-w-0 items-center gap-8">
										<span class="icon-[lucide--folder] shrink-0 text-accent"></span>
										<span class="truncate text-sm font-medium">{folder.name || 'Items without a folder'}</span>
										<span class="shrink-0 text-xs text-muted">· {itemCount} {itemCount === 1 ? 'item' : 'items'}</span>
									</div>
									<p class="shrink-0 text-[11px] text-muted">
										{lastUpdated === null ? 'No items' : formatDate(lastUpdated)}
									</p>
								</div>
							</div>
						{/each}
					</div>
				</section>

				<section class="rounded-xl border border-danger/40 bg-danger/5 p-16 md:p-20">
					<h3 class="text-sm font-medium text-danger">Replace this device's vault?</h3>
					<p class="mt-4 text-xs text-muted">
						Restore replaces all local folders and items. It does not immediately overwrite the vault on Drive.
					</p>
					<div class="mt-16 flex flex-wrap justify-end gap-8">
						<Button variant="ghost" onclick={onclose}>Cancel</Button>
						<Button variant="danger" disabled={restoring} onclick={restoreBackup}>
							{restoring ? 'Restoring…' : 'Restore this backup'}
						</Button>
					</div>
				</section>
			{/if}
		</div>
	</div>
</div>
