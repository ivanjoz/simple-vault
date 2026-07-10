<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import Button from './Button.svelte';
</script>

<div class="flex min-h-screen items-center justify-center p-6">
	<div class="w-full max-w-sm rounded-2xl border border-border bg-surface p-7 shadow-xl">
		<div class="mb-4 h-9 w-9 rounded-lg bg-accent"></div>
		<h1 class="text-xl font-semibold">Simple Vault</h1>
		<p class="mt-2 text-sm text-muted">
			Your vault is stored encrypted in your Google Drive. Connect to open an existing vault or
			create a new one.
		</p>

		{#if vault.error}
			<p class="mt-4 text-xs text-danger">{vault.error}</p>
		{/if}

		<div class="mt-6 flex flex-col gap-3">
			<Button full disabled={vault.busy} onclick={() => vault.connectAtStartup()}>
				{vault.busy ? 'Connecting…' : 'Connect Google Drive'}
			</Button>
			<button
				type="button"
				class="text-center text-xs text-muted transition-colors hover:text-text"
				onclick={() => vault.setupLocally()}
			>
				Set up locally instead
			</button>
		</div>
	</div>
</div>
