<script lang="ts">
	// A numeric PIN pad. Bindable `value` holds the entered digits; the caller
	// decides when to submit (or passes `onsubmit`, fired when Enter/✓ is pressed).
	interface Props {
		value?: string;
		min?: number;
		max?: number;
		onsubmit?: () => void;
		disabled?: boolean;
	}

	let {
		value = $bindable(''),
		min = 4,
		max = 8,
		onsubmit,
		disabled = false
	}: Props = $props();

	const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

	function press(d: string) {
		if (disabled || value.length >= max) return;
		value += d;
	}
	function back() {
		if (disabled) return;
		value = value.slice(0, -1);
	}
	function submit() {
		if (disabled || value.length < min) return;
		onsubmit?.();
	}
</script>

<div class="flex flex-col items-center gap-16">
	<!-- Progress dots (grow with length, up to max) -->
	<div class="flex h-16 items-center gap-10">
		{#each Array(max) as _, i (i)}
			<span
				class="h-10 w-10 rounded-full border border-border transition-colors {i < value.length
					? 'bg-accent border-accent'
					: 'bg-transparent'}"
			></span>
		{/each}
	</div>

	<div class="grid grid-cols-3 gap-12">
		{#each keys as k (k)}
			<button
				type="button"
				{disabled}
				onclick={() => press(k)}
				class="h-56 w-56 rounded-full border border-border bg-surface-2 text-lg font-medium text-text transition-colors hover:border-accent disabled:opacity-50"
			>
				{k}
			</button>
		{/each}
		<button
			type="button"
			{disabled}
			onclick={back}
			class="h-56 w-56 rounded-full text-sm text-muted transition-colors hover:text-text disabled:opacity-50"
			aria-label="Delete"
		>
			⌫
		</button>
		<button
			type="button"
			{disabled}
			onclick={() => press('0')}
			class="h-56 w-56 rounded-full border border-border bg-surface-2 text-lg font-medium text-text transition-colors hover:border-accent disabled:opacity-50"
		>
			0
		</button>
		<button
			type="button"
			disabled={disabled || value.length < min}
			onclick={submit}
			class="h-56 w-56 rounded-full bg-accent text-lg font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-40"
			aria-label="Confirm"
		>
			✓
		</button>
	</div>
</div>
