<script lang="ts">
	import { onMount } from 'svelte';
	import { vault } from '$lib/app/vault.svelte';
	import type { Bytes } from '$lib/crypto';
	import type { DriveFile } from '$lib/drive/client';
	import Button from './Button.svelte';

	let {
		onclose,
		onrestore
	}: {
		onclose: () => void;
		onrestore: (source: { name: string; bytes: Bytes }) => void;
	} = $props();

	let backups = $state<DriveFile[]>([]);
	let loaded = $state(false);
	let loading = $state(false);
	let notice = $state('');

	onMount(() => {
		if (vault.driveConnected) void refresh();
	});

	async function refresh() {
		if (loading || vault.busy) return;
		loading = true;
		notice = '';
		const result = await vault.listDriveBackups();
		if (result) {
			backups = result;
			loaded = true;
		}
		loading = false;
	}

	async function createBackup() {
		if (loading || vault.busy) return;
		notice = '';
		const ok = await vault.createDriveBackup();
		if (!ok) return;
		await refresh();
		notice = 'Encrypted Drive backup created.';
	}

	async function restoreBackup(file: DriveFile) {
		if (loading || vault.busy) return;
		notice = '';
		const bytes = await vault.fetchDriveBackup(file.id);
		if (bytes) onrestore({ name: file.name, bytes });
	}

	function formatDate(value?: string): string {
		if (!value) return 'Unknown date';
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return 'Unknown date';
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(date);
	}

	function formatSize(value?: string): string {
		const bytes = Number(value);
		if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
		if (bytes < 1_024) return `${bytes} B`;
		if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
		return `${(bytes / 1_048_576).toFixed(1)} MB`;
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
		<h1 class="text-base font-semibold">Manage Backups</h1>
	</header>

	<div class="flex-1 overflow-y-auto p-16 md:p-24">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-20">
			<section class="rounded-xl border border-border bg-surface p-16 md:p-20">
				<div class="flex items-start justify-between gap-16">
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-8">
							<span class="icon-[lucide--cloud-upload] text-[20px] text-accent"></span>
							<h2 class="text-lg font-semibold">Drive backups</h2>
						</div>
						<p class="mt-6 text-sm text-muted">
							Create an encrypted snapshot of the vault currently stored on this device. Simple
							Vault keeps the newest 10 snapshots in its private Google Drive storage.
						</p>
					</div>
					<Button class="shrink-0" disabled={loading || vault.busy} onclick={createBackup}>
						{vault.busy ? 'Working…' : '+ Create'}
					</Button>
				</div>

				<div class="mt-16 rounded-lg border border-border bg-surface-2 p-12 text-xs text-muted">
					Backups are hidden from the regular Drive interface and remain encrypted. A historical
					backup may require the master password or recovery key that was valid when it was created.
				</div>
			</section>

			{#if vault.error}
				<div class="rounded-xl border border-danger/40 bg-danger/5 p-14 text-sm text-danger">
					{vault.error}
				</div>
			{/if}

			{#if notice}
				<div class="rounded-xl border border-success/40 bg-surface p-14 text-sm text-success">
					{notice}
				</div>
			{/if}

			<section class="rounded-xl border border-border bg-surface p-16 md:p-20">
				<div class="flex items-center justify-between gap-12">
					<div>
						<h2 class="text-sm font-medium">Available backups</h2>
						<p class="mt-4 text-xs text-muted">
							{loaded ? `${backups.length} of 10 backup slots used` : 'Connect Drive to load backups.'}
						</p>
					</div>
					<Button variant="ghost" disabled={loading || vault.busy} onclick={refresh}>
						<span class="icon-[lucide--refresh-cw] text-[16px] {loading ? 'animate-spin' : ''}"></span>
						{loading ? 'Loading…' : loaded ? 'Refresh' : 'Connect Drive'}
					</Button>
				</div>

				{#if loading && !loaded}
					<div class="flex min-h-160 items-center justify-center text-sm text-muted">Loading backups…</div>
				{:else if loaded && backups.length === 0}
					<div class="flex min-h-160 flex-col items-center justify-center gap-8 text-center text-muted">
						<span class="icon-[lucide--archive] text-[28px]"></span>
						<p class="text-sm">No Drive backups yet.</p>
					</div>
				{:else if backups.length > 0}
					<div class="mt-16 space-y-8">
						{#each backups as backup (backup.id)}
							<div class="flex flex-col gap-12 rounded-lg border border-border bg-surface-2 p-12 sm:flex-row sm:items-center">
								<div class="flex min-w-0 flex-1 items-center gap-12">
									<span class="icon-[lucide--database-backup] shrink-0 text-[20px] text-accent"></span>
									<div class="min-w-0">
										<p class="text-sm font-medium">Drive backup</p>
										<p class="mt-2 text-xs text-muted">
											{formatDate(backup.createdTime ?? backup.modifiedTime)} · {formatSize(backup.size)}
										</p>
									</div>
								</div>
								<div class="flex shrink-0 justify-end gap-4">
									<Button variant="ghost" size="sm" disabled={vault.busy} onclick={() => vault.downloadDriveBackup(backup)}>
										<span class="icon-[lucide--download] text-[16px]"></span>
										Download
									</Button>
									<Button variant="ghost" size="sm" disabled={vault.busy} onclick={() => restoreBackup(backup)}>
										<span class="icon-[lucide--archive-restore] text-[16px]"></span>
										Restore
									</Button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		</div>
	</div>
</div>
