<script lang="ts">
	import { onMount } from 'svelte';
	import { vault } from '$lib/app/vault.svelte';
	import Connect from '$lib/ui/Connect.svelte';
	import Onboarding from '$lib/ui/Onboarding.svelte';
	import Unlock from '$lib/ui/Unlock.svelte';
	import RecoveryKeyDialog from '$lib/ui/RecoveryKeyDialog.svelte';
	import Vault from '$lib/ui/Vault.svelte';

	onMount(() => {
		void vault.init();
	});
</script>

{#if vault.status === 'loading'}
	<div class="flex min-h-screen items-center justify-center text-sm text-muted">Loading…</div>
{:else if vault.status === 'connect'}
	<Connect />
{:else if vault.status === 'onboarding'}
	<Onboarding />
{:else if vault.status === 'locked'}
	<Unlock />
{:else}
	<Vault />
{/if}

{#if vault.recoveryKeyOnce}
	<RecoveryKeyDialog recoveryKey={vault.recoveryKeyOnce} />
{/if}
