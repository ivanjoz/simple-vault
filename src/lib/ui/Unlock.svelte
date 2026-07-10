<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import Button from './Button.svelte';
	import TextField from './TextField.svelte';

	let mode = $state<'password' | 'recovery'>('password');
	let secret = $state('');

	function submit() {
		if (!secret || vault.busy) return;
		void vault.unlock(secret, mode);
	}

	function toggleMode() {
		mode = mode === 'password' ? 'recovery' : 'password';
		secret = '';
		vault.error = null;
	}
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-sm rounded-2xl border border-border bg-surface p-7 shadow-xl">
		<h1 class="text-xl font-semibold">Unlock vault</h1>
		<p class="mt-2 text-sm text-muted">
			{mode === 'password'
				? 'Enter your master password.'
				: 'Enter your recovery key (dashes optional).'}
		</p>

		<div class="mt-6 flex flex-col gap-4">
			{#if mode === 'password'}
				<TextField
					label="Master password"
					type="password"
					autocomplete="current-password"
					bind:value={secret}
					onenter={submit}
				/>
			{:else}
				<TextField
					label="Recovery key"
					mono
					placeholder="XXXX-XXXX-XXXX-XXXX"
					bind:value={secret}
					onenter={submit}
				/>
			{/if}

			{#if vault.error}
				<p class="text-xs text-danger">{vault.error}</p>
			{/if}

			<Button type="button" full disabled={!secret || vault.busy} onclick={submit}>
				{vault.busy ? 'Unlocking…' : 'Unlock'}
			</Button>

			<button
				type="button"
				class="text-center text-xs text-muted transition-colors hover:text-text"
				onclick={toggleMode}
			>
				{mode === 'password' ? 'Use recovery key instead' : 'Use master password instead'}
			</button>
		</div>
	</div>
</div>
