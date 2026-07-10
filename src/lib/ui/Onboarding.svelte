<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import Button from './Button.svelte';
	import TextField from './TextField.svelte';

	let password = $state('');
	let confirm = $state('');

	const tooShort = $derived(password.length > 0 && password.length < 8);
	const mismatch = $derived(confirm.length > 0 && password !== confirm);
	const canSubmit = $derived(password.length >= 8 && password === confirm && !vault.busy);

	function submit() {
		if (!canSubmit) return;
		void vault.createVault(password);
	}
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-sm rounded-2xl border border-border bg-surface p-7 shadow-xl">
		<h1 class="text-xl font-semibold">Create your vault</h1>
		<p class="mt-2 text-sm text-muted">
			Choose a master password. It never leaves your device and cannot be recovered — you'll get a
			recovery key next.
		</p>

		<div class="mt-6 flex flex-col gap-4">
			<TextField
				label="Master password"
				type="password"
				autocomplete="new-password"
				bind:value={password}
			/>
			<TextField
				label="Confirm password"
				type="password"
				autocomplete="new-password"
				bind:value={confirm}
				onenter={submit}
			/>

			{#if tooShort}
				<p class="text-xs text-danger">Use at least 8 characters.</p>
			{:else if mismatch}
				<p class="text-xs text-danger">Passwords don't match.</p>
			{/if}
			{#if vault.error}
				<p class="text-xs text-danger">{vault.error}</p>
			{/if}

			<Button type="button" full disabled={!canSubmit} onclick={submit}>
				{vault.busy ? 'Creating…' : 'Create vault'}
			</Button>
		</div>
	</div>
</div>
