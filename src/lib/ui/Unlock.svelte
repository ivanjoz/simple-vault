<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import Button from './Button.svelte';
	import TextField from './TextField.svelte';
	import PinPad from './PinPad.svelte';

	let mode = $state<'password' | 'recovery'>('password');
	let secret = $state('');
	let pin = $state('');
	// Show the device-local unlocker (biometrics/PIN) first when one is enrolled.
	let usePassword = $state(vault.localUnlockKind === null);

	function submitPassword() {
		if (!secret || vault.busy) return;
		void vault.unlock(secret, mode);
	}

	function submitPin() {
		if (!pin || vault.busy) return;
		vault.unlockLocal(pin).finally(() => {
			pin = '';
		});
	}

	function biometric() {
		if (vault.busy) return;
		void vault.unlockLocal();
	}

	function toggleMode() {
		mode = mode === 'password' ? 'recovery' : 'password';
		secret = '';
		vault.error = null;
	}

	function showPassword() {
		usePassword = true;
		vault.error = null;
	}

	function showLocal() {
		usePassword = false;
		secret = '';
		pin = '';
		vault.error = null;
	}
</script>

<div class="flex min-h-screen items-center justify-center p-24">
	<div class="w-full max-w-sm rounded-2xl border border-border bg-surface p-28 shadow-xl">
		<h1 class="text-xl font-semibold">Unlock vault</h1>

		{#if !usePassword && vault.localUnlockKind === 'webauthn'}
			<!-- Device unlock: the OS prompt accepts fingerprint / face / pattern / PIN. -->
			<p class="mt-8 text-sm text-muted">Use your phone's fingerprint, face, pattern, or PIN.</p>
			<div class="mt-24 flex flex-col gap-16">
				{#if vault.error}<p class="text-xs text-danger">{vault.error}</p>{/if}
				<Button type="button" full disabled={vault.busy} onclick={biometric}>
					{vault.busy ? 'Unlocking…' : 'Unlock with this device'}
				</Button>
				<button
					type="button"
					class="text-center text-xs text-muted transition-colors hover:text-text"
					onclick={showPassword}
				>
					Use master password instead
				</button>
			</div>
		{:else if !usePassword && vault.localUnlockKind === 'pin'}
			<!-- App PIN unlock (a separate PIN chosen for this app, not the phone lock). -->
			<p class="mt-8 text-sm text-muted">Enter your app PIN.</p>
			<div class="mt-24 flex flex-col items-center gap-16">
				<PinPad bind:value={pin} onsubmit={submitPin} disabled={vault.busy} />
				{#if vault.error}<p class="text-xs text-danger">{vault.error}</p>{/if}
				<button
					type="button"
					class="text-center text-xs text-muted transition-colors hover:text-text"
					onclick={showPassword}
				>
					Use master password instead
				</button>
			</div>
		{:else}
			<!-- Master password / recovery key -->
			<p class="mt-8 text-sm text-muted">
				{mode === 'password'
					? 'Enter your master password.'
					: 'Enter your recovery key (dashes optional).'}
			</p>

			<div class="mt-24 flex flex-col gap-16">
				{#if mode === 'password'}
					<TextField
						label="Master password"
						type="password"
						autocomplete="current-password"
						bind:value={secret}
						onenter={submitPassword}
					/>
				{:else}
					<TextField
						label="Recovery key"
						mono
						placeholder="XXXX-XXXX-XXXX-XXXX"
						bind:value={secret}
						onenter={submitPassword}
					/>
				{/if}

				{#if vault.error}
					<p class="text-xs text-danger">{vault.error}</p>
				{/if}

				<Button type="button" full disabled={!secret || vault.busy} onclick={submitPassword}>
					{vault.busy ? 'Unlocking…' : 'Unlock'}
				</Button>

				<div class="flex flex-col gap-8">
					<button
						type="button"
						class="text-center text-xs text-muted transition-colors hover:text-text"
						onclick={toggleMode}
					>
						{mode === 'password' ? 'Use recovery key instead' : 'Use master password instead'}
					</button>
					{#if vault.localUnlockKind}
						<button
							type="button"
							class="text-center text-xs text-muted transition-colors hover:text-text"
							onclick={showLocal}
						>
							{vault.localUnlockKind === 'webauthn'
								? 'Unlock with this device instead'
								: 'Use app PIN instead'}
						</button>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>
