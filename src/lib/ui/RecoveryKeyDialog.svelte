<script lang="ts">
	import { vault } from '$lib/app/vault.svelte';
	import { downloadText } from '$lib/app/download';
	import Button from './Button.svelte';

	let { recoveryKey }: { recoveryKey: string } = $props();
	let downloaded = $state(false);

	function download() {
		downloadText('simple-vault-recovery-key.txt', recoveryKey);
		downloaded = true;
	}
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-24">
	<div class="w-full max-w-md rounded-2xl border border-border bg-surface p-28 shadow-2xl">
		<h2 class="text-lg font-semibold">Save your recovery key</h2>
		<p class="mt-8 text-sm text-muted">
			This is the only way to unlock your vault if you forget your master password. Store it
			somewhere safe — it will not be shown again.
		</p>

		<div
			class="mt-20 rounded-lg border border-border bg-surface-2 px-16 py-16 text-center font-mono text-lg tracking-widest text-accent select-all"
		>
			{recoveryKey}
		</div>

		<div class="mt-24 flex flex-col gap-12">
			<Button full onclick={download}>Download recovery key</Button>
			<Button variant="ghost" full disabled={!downloaded} onclick={() => vault.dismissRecoveryKey()}>
				{downloaded ? "I've saved it — continue" : 'Download first to continue'}
			</Button>
		</div>
	</div>
</div>
