<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import Button from './Button.svelte';
	import TextField from './TextField.svelte';

	let { onclose }: { onclose: () => void } = $props();

	let newPassword = $state('');
	let confirm = $state('');
	let passwordNote = $state('');
	let fileInput = $state<HTMLInputElement | null>(null);

	const canChange = $derived(newPassword.length >= 8 && newPassword === confirm && !vault.busy);

	async function changePassword() {
		if (!canChange) return;
		const ok = await vault.changeMasterPassword(newPassword);
		if (ok) {
			newPassword = '';
			confirm = '';
			passwordNote = 'Master password changed and vault re-encrypted.';
		}
	}

	async function importFile(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		await vault.importVault(await file.text());
		onclose();
	}
</script>

<div
	class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-24"
	onclick={onclose}
	onkeydown={() => {}}
	role="presentation"
>
	<div
		class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-24 shadow-2xl"
		onclick={(e) => e.stopPropagation()}
		onkeydown={() => {}}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div class="flex items-center justify-between">
			<h2 class="text-lg font-semibold">Settings</h2>
			<Button variant="ghost" onclick={onclose}>Close</Button>
		</div>

		{#if vault.error}
			<p class="mt-12 text-xs text-danger">{vault.error}</p>
		{/if}

		<!-- Session persistence -->
		<section class="mt-24 border-t border-border pt-20">
			<h3 class="text-sm font-medium">Stay unlocked in this tab</h3>
			<p class="mt-4 text-xs text-muted">
				Keeps the vault unlocked across page reloads until you close the tab. Convenient, but the
				key is held in this tab's <code>sessionStorage</code> — a small tradeoff vs. re-entering
				your master password each reload.
			</p>
			<label class="mt-12 flex items-center gap-8 text-sm">
				<input
					type="checkbox"
					checked={vault.persistSession}
					onchange={(e) => vault.setPersistSession((e.target as HTMLInputElement).checked)}
				/>
				Enabled
			</label>
		</section>

		<!-- Change master password -->
		<section class="mt-24 border-t border-border pt-20">
			<h3 class="text-sm font-medium">Change master password</h3>
			<p class="mt-4 text-xs text-muted">Rotates the key and re-encrypts everything.</p>
			<div class="mt-12 flex flex-col gap-12">
				<TextField label="New password" type="password" autocomplete="new-password" bind:value={newPassword} />
				<TextField label="Confirm" type="password" autocomplete="new-password" bind:value={confirm} />
				<Button disabled={!canChange} onclick={changePassword}>
					{vault.busy ? 'Working…' : 'Change password'}
				</Button>
				{#if passwordNote}<p class="text-xs text-success">{passwordNote}</p>{/if}
			</div>
		</section>

		<!-- Recovery key -->
		<section class="mt-24 border-t border-border pt-20">
			<h3 class="text-sm font-medium">Recovery key</h3>
			<p class="mt-4 text-xs text-muted">Generate a new key; the old one stops working.</p>
			<div class="mt-12">
				<Button variant="ghost" onclick={() => vault.regenerateRecoveryKey()}>
					Regenerate recovery key
				</Button>
			</div>
		</section>

		<!-- Backup -->
		<section class="mt-24 border-t border-border pt-20">
			<h3 class="text-sm font-medium">Backup</h3>
			<p class="mt-4 text-xs text-muted">The export is encrypted; import replaces this device's vault.</p>
			<div class="mt-12 flex gap-8">
				<Button variant="ghost" onclick={() => vault.exportVault()}>Export</Button>
				<Button variant="ghost" onclick={() => fileInput?.click()}>Import</Button>
				<input
					bind:this={fileInput}
					type="file"
					accept="application/json,.json"
					class="hidden"
					onchange={importFile}
				/>
			</div>
		</section>

		<!-- Danger zone -->
		<section class="mt-24 border-t border-border pt-20">
			<h3 class="text-sm font-medium text-danger">Danger zone</h3>
			<div class="mt-12 flex gap-8">
				{#if vault.driveConnected}
					<Button variant="ghost" onclick={() => vault.disconnectDrive()}>Disconnect Drive</Button>
				{/if}
				<Button
					variant="danger"
					onclick={() => {
						if (window.confirm('Wipe all local data on this device? Your Drive copy is kept.'))
							void vault.wipeLocal();
					}}
				>
					Wipe local data
				</Button>
			</div>
		</section>
	</div>
</div>
