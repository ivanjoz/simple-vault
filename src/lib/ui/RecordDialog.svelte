<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { vault } from '$lib/app/vault.svelte';
	import { generatePassword } from '$lib/app/password';
	import { SECRET_TTL_MS, expireAfter, type Cancellable } from '$lib/session/ttl';
	import type { CardView, HistoryItem } from '$lib/vault/types';
	import Button from './Button.svelte';
	import TextField from './TextField.svelte';

	let { card, onclose }: { card: CardView | null; onclose: () => void } = $props();

	// Snapshot the card once at mount: the form fields are seeded from it and
	// then edited independently, so we intentionally capture only the initial
	// value (the dialog is destroyed/recreated each time it opens).
	const initialCard = untrack(() => card);
	const isEdit = initialCard !== null;

	let title = $state(initialCard?.title ?? '');
	let username = $state(initialCard?.username ?? '');
	let folderId = $state(initialCard?.folderId ?? '');
	let url = $state('');
	let notes = $state('');
	// For a new record we generate a strong password up front; for edits, blank
	// means "keep current" so the stored password is never loaded unnecessarily.
	let password = $state(isEdit ? '' : generatePassword());
	let revealed = $state<string | null>(null);
	let history = $state<HistoryItem[] | null>(null);
	let loading = $state(isEdit);
	let saving = $state(false);

	let revealTimer: Cancellable | null = null;

	// Load current secret fields for editing. History remains encrypted.
	if (isEdit && initialCard) {
		void vault.getSecret(initialCard.id).then((secret) => {
			loading = false;
			if (secret) {
				url = secret.url;
				notes = secret.notes;
			}
		});
	}

	function clearReveal() {
		revealed = null;
		history = null;
		revealTimer?.cancel();
		revealTimer = null;
	}

	async function reveal() {
		if (!card) return;
		const [secret, storedHistory] = await Promise.all([
			vault.getSecret(card.id),
			vault.getHistory(card.id)
		]);
		if (!secret) return;
		revealed = secret.password;
		history = storedHistory;
		revealTimer?.cancel();
		revealTimer = expireAfter(SECRET_TTL_MS, clearReveal);
	}

	function generate() {
		password = generatePassword();
	}

	async function save() {
		if (!title.trim() || saving) return;
		saving = true;
		await vault.saveRecord({ id: card?.id, folderId, title, username, password, url, notes });
		clearReveal();
		onclose();
	}

	async function remove() {
		if (!card) return;
		await vault.deleteRecord(card.id);
		onclose();
	}

	onDestroy(clearReveal);
</script>

<div class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-24" onclick={onclose} onkeydown={() => {}} role="presentation">
	<div
		class="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-surface p-18 shadow-2xl"
		onclick={(e) => e.stopPropagation()}
		onkeydown={() => {}}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<h2 class="text-lg font-semibold">{isEdit ? 'Edit Record' : 'New Record'}</h2>

		<div class="mt-20 grid grid-cols-1 gap-16 sm:grid-cols-[54fr_46fr]">
			<!-- Left column: identity + credentials -->
			<div class="flex flex-col gap-16">
				<TextField label="Title" bind:value={title} placeholder="e.g. GitHub" />
				<TextField label="Username" bind:value={username} autocomplete="off" />

				<TextField label="Site URL" bind:value={url} placeholder="https://example.com" autocomplete="off" />

				<div class="flex flex-col gap-6">
					<span class="text-xs font-medium tracking-wide text-muted uppercase">Password</span>
					<div class="flex gap-8">
						<input
							type="text"
							bind:value={password}
							placeholder={isEdit ? 'Leave blank to keep current' : ''}
							class="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-12 py-8 font-mono text-sm text-text outline-none focus:border-accent"
						/>
						<Button variant="ghost" onclick={generate}>Generate</Button>
					</div>
					{#if isEdit}
						{#if revealed === null}
							<button class="self-start text-xs text-muted hover:text-text" onclick={reveal}>
								Reveal current password
							</button>
						{:else}
							<div class="rounded-md bg-surface-2 px-12 py-8 font-mono text-sm text-accent break-all">
								{revealed}
								<span class="ml-8 text-xs text-muted">(hides in 40s)</span>
							</div>
						{/if}
					{/if}
				</div>
			</div>

			<!-- Right column: folder + notes -->
			<div class="flex flex-col gap-16">
				<label class="flex flex-col gap-6">
					<span class="text-xs font-medium tracking-wide text-muted uppercase">Folder</span>
					<select
						bind:value={folderId}
						class="rounded-lg border border-border bg-surface-2 px-12 py-8 text-sm text-text outline-none focus:border-accent"
					>
						<option value="">No folder</option>
						{#each vault.folders as f (f.id)}
							<option value={f.id}>{f.name}</option>
						{/each}
					</select>
				</label>

				<label class="flex flex-1 flex-col gap-6">
					<span class="text-xs font-medium tracking-wide text-muted uppercase">Notes</span>
					<textarea
						bind:value={notes}
						class="min-h-[120px] flex-1 resize-none rounded-lg border border-border bg-surface-2 px-12 py-8 text-sm text-text outline-none focus:border-accent"
					></textarea>
				</label>
			</div>
		</div>

		{#if history && history.length > 0}
			<div class="mt-16 rounded-lg border border-border bg-surface-2 p-12">
				<div class="mb-8 text-xs font-medium tracking-wide text-muted uppercase">
					Password history
				</div>
				<ul class="flex flex-col gap-4">
					{#each history as h (h[1])}
						<li class="flex justify-between gap-12 text-xs">
							<span class="truncate font-mono text-text">{h[0]}</span>
							<span class="shrink-0 text-muted">{new Date(h[1] * 1000).toLocaleDateString()}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div class="mt-24 flex items-center justify-between">
			{#if isEdit}
				<Button variant="danger" onclick={remove}>Delete</Button>
			{:else}
				<span></span>
			{/if}
			<div class="flex gap-8">
				<Button disabled={!title.trim() || saving || loading} onclick={save}>
					{saving ? 'Saving…' : 'Save'}
				</Button>
				<Button variant="ghost" onclick={onclose}>Cancel</Button>
			</div>
		</div>
	</div>
</div>
