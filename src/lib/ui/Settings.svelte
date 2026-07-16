<script lang="ts">
	import { vault, AUTOLOCK_OPTIONS } from '$lib/app/vault.svelte';
	import Button from './Button.svelte';
	import TextField from './TextField.svelte';
	import PinPad from './PinPad.svelte';

	let { onclose, onrestore }: { onclose: () => void; onrestore: () => void } = $props();

	let newPassword = $state('');
	let confirm = $state('');
	let passwordNote = $state('');

	// App-lock (biometrics / PIN) enrolment state.
	let showPinSetup = $state(false);
	let pinStep = $state<'enter' | 'confirm'>('enter');
	let firstPin = $state('');
	let pinValue = $state('');
	let appLockNote = $state('');

	const canChange = $derived(newPassword.length >= 8 && newPassword === confirm && !vault.busy);

	async function changePassword() {
		if (!canChange) return;
		const ok = await vault.changeMasterPassword(newPassword);
		if (ok) {
			newPassword = '';
			confirm = '';
			passwordNote = 'Master password changed and vault re-encrypted.';
			appLockNote = vault.localUnlockKind ? '' : 'App lock was reset — re-enable it below.';
		}
	}

	async function enableBiometric() {
		appLockNote = '';
		const ok = await vault.enrollBiometric();
		if (ok) appLockNote = 'Device unlock enabled.';
	}

	function startPinSetup() {
		showPinSetup = true;
		pinStep = 'enter';
		firstPin = '';
		pinValue = '';
		appLockNote = '';
		vault.error = null;
	}

	function cancelPinSetup() {
		showPinSetup = false;
		firstPin = '';
		pinValue = '';
	}

	async function pinStepSubmit() {
		if (pinStep === 'enter') {
			firstPin = pinValue;
			pinValue = '';
			pinStep = 'confirm';
			return;
		}
		if (pinValue !== firstPin) {
			vault.error = 'PINs did not match. Start again.';
			firstPin = '';
			pinValue = '';
			pinStep = 'enter';
			return;
		}
		const ok = await vault.enrollPin(pinValue);
		if (ok) {
			showPinSetup = false;
			firstPin = '';
			pinValue = '';
			appLockNote = 'PIN unlock enabled.';
		}
	}

	async function disableAppLock() {
		await vault.disableLocalUnlock();
		appLockNote = 'App lock disabled.';
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

		<!-- App lock (device unlock / app PIN) -->
		<section class="mt-24 border-t border-border pt-20">
			<h3 class="text-sm font-medium">App lock</h3>
			<p class="mt-4 text-xs text-muted">
				{#if vault.platformAuthAvailable}
					Unlock with your phone's own lock — fingerprint, face, pattern, or PIN — instead of your
					master password. Your phone verifies you; the vault key stays on this device only and is
					never synced to Drive.
				{:else}
					This device has no built-in authenticator, so you can set a separate app PIN (chosen here,
					not your phone's lock) for a quick unlock. It stays on this device only.
				{/if}
			</p>

			{#if vault.localUnlockKind}
				<p class="mt-12 text-sm text-success">
					Enabled: {vault.localUnlockKind === 'webauthn'
						? 'Device unlock (your phone lock)'
						: 'App PIN'}
				</p>
				<div class="mt-12">
					<Button variant="ghost" onclick={disableAppLock}>Disable app lock</Button>
				</div>
			{:else if showPinSetup}
				<div class="mt-16 flex flex-col items-center gap-12">
					<p class="text-xs text-muted">
						{pinStep === 'enter'
							? 'Choose an app PIN (4–8 digits) you will remember.'
							: 'Re-enter the PIN to confirm.'}
					</p>
					<PinPad bind:value={pinValue} onsubmit={pinStepSubmit} disabled={vault.busy} />
					<button
						type="button"
						class="text-xs text-muted transition-colors hover:text-text"
						onclick={cancelPinSetup}
					>
						Cancel
					</button>
				</div>
			{:else}
				<div class="mt-12 flex flex-wrap gap-8">
					{#if vault.platformAuthAvailable}
						<Button onclick={enableBiometric} disabled={vault.busy}>Enable device unlock</Button>
						<Button variant="ghost" onclick={startPinSetup}>Use an app PIN instead</Button>
					{:else}
						<Button onclick={startPinSetup}>Set up an app PIN</Button>
					{/if}
				</div>
				<p class="mt-8 text-xs text-muted">
					An app PIN is a separate secret you choose here (not your phone's lock). It's weaker than
					your master password — it can be guessed offline if this device is compromised — so keep
					it only for convenience; your master password always works.
				</p>
			{/if}
			{#if appLockNote}<p class="mt-8 text-xs text-success">{appLockNote}</p>{/if}
		</section>

		<!-- Auto-lock -->
		<section class="mt-24 border-t border-border pt-20">
			<h3 class="text-sm font-medium">Auto-lock</h3>
			<p class="mt-4 text-xs text-muted">
				Re-lock after the app has been in the background this long. When it re-locks you'll need
				your {vault.localUnlockKind
					? vault.localUnlockKind === 'webauthn'
						? 'phone lock'
						: 'app PIN'
					: 'master password'} to get back in.
			</p>
			<label class="mt-12 flex items-center gap-8 text-sm">
				<select
					class="rounded-lg border border-border bg-surface-2 px-12 py-8 text-sm text-text outline-none focus:border-accent"
					value={String(vault.autoLockMs)}
					onchange={(e) => vault.setAutoLockMs(Number((e.target as HTMLSelectElement).value))}
				>
					{#each AUTOLOCK_OPTIONS as opt (opt.ms)}
						<option value={String(opt.ms)}>{opt.label}</option>
					{/each}
				</select>
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
			<p class="mt-4 text-xs text-muted">
				Download the current key, or generate a new one and invalidate the old key.
			</p>
			<div class="mt-12 flex flex-wrap gap-8">
				<Button variant="ghost" disabled={vault.busy} onclick={() => vault.downloadCurrentRecoveryKey()}>
					{vault.busy ? 'Working…' : 'Download recovery key'}
				</Button>
				<Button variant="ghost" disabled={vault.busy} onclick={() => vault.regenerateRecoveryKey()}>
					Regenerate recovery key
				</Button>
			</div>
		</section>

		<!-- Backup -->
		<section class="mt-24 border-t border-border pt-20">
			<h3 class="text-sm font-medium">Backup</h3>
			<p class="mt-4 text-xs text-muted">The export is encrypted; import replaces this device's vault.</p>
			<div class="mt-12 flex gap-8">
				<Button variant="ghost" disabled={vault.busy} onclick={() => vault.exportVault()}>
					{vault.busy ? 'Exporting…' : 'Export'}
				</Button>
				<Button variant="ghost" onclick={onrestore}>Import</Button>
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
