<script lang="ts">
	import { onDestroy } from 'svelte';
	import { vault } from '$lib/app/vault.svelte';
	import { generatePassword } from '$lib/app/password';
	import { SECRET_TTL_MS, expireAfter, type Cancellable } from '$lib/session/ttl';
	import type { CardView, HistoryItem } from '$lib/vault/types';
	import Button from './Button.svelte';
	import TextField from './TextField.svelte';

	let { card, onclose }: { card: CardView | null; onclose: () => void } = $props();

	const isEdit = card !== null;

	let title = $state(card?.title ?? '');
	let username = $state(card?.username ?? '');
	let folderId = $state(card?.folderId ?? '');
	let notes = $state('');
	// For a new record we generate a strong password up front; for edits, blank
	// means "keep current" so the stored password is never loaded unnecessarily.
	let password = $state(isEdit ? '' : generatePassword());
	let revealed = $state<string | null>(null);
	let history = $state<HistoryItem[] | null>(null);
	let loading = $state(isEdit);
	let saving = $state(false);

	let revealTimer: Cancellable | null = null;

	// Load notes (and history) for an existing record. The password is NOT kept.
	if (isEdit && card) {
		void vault.getSecret(card.id).then((secret) => {
			loading = false;
			if (secret) notes = secret.notes;
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
		const secret = await vault.getSecret(card.id);
		if (!secret) return;
		revealed = secret.password;
		history = secret.history;
		revealTimer?.cancel();
		revealTimer = expireAfter(SECRET_TTL_MS, clearReveal);
	}

	function generate() {
		password = generatePassword();
	}

	async function save() {
		if (!title.trim() || saving) return;
		saving = true;
		await vault.saveRecord({ id: card?.id, folderId, title, username, password, notes });
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
		class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-24 shadow-2xl"
		onclick={(e) => e.stopPropagation()}
		onkeydown={() => {}}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<h2 class="text-lg font-semibold">{isEdit ? 'Edit item' : 'New item'}</h2>

		<div class="mt-20 flex flex-col gap-16">
			<TextField label="Title" bind:value={title} placeholder="e.g. GitHub" />
			<TextField label="Username" bind:value={username} autocomplete="off" />

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

			<label class="flex flex-col gap-6">
				<span class="text-xs font-medium tracking-wide text-muted uppercase">Notes</span>
				<textarea
					bind:value={notes}
					rows="3"
					class="resize-none rounded-lg border border-border bg-surface-2 px-12 py-8 text-sm text-text outline-none focus:border-accent"
				></textarea>
			</label>

			{#if history && history.length > 0}
				<div class="rounded-lg border border-border bg-surface-2 p-12">
					<div class="mb-8 text-xs font-medium tracking-wide text-muted uppercase">
						Password history
					</div>
					<ul class="flex flex-col gap-4">
						{#each history as h (h.u)}
							<li class="flex justify-between gap-12 text-xs">
								<span class="truncate font-mono text-text">{h.p}</span>
								<span class="shrink-0 text-muted">{new Date(h.u).toLocaleDateString()}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>

		<div class="mt-24 flex items-center justify-between">
			{#if isEdit}
				<Button variant="danger" onclick={remove}>Delete</Button>
			{:else}
				<span></span>
			{/if}
			<div class="flex gap-8">
				<Button variant="ghost" onclick={onclose}>Cancel</Button>
				<Button disabled={!title.trim() || saving || loading} onclick={save}>
					{saving ? 'Saving…' : 'Save'}
				</Button>
			</div>
		</div>
	</div>
</div>
