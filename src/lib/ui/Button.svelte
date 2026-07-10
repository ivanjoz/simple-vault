<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		type?: 'button' | 'submit';
		variant?: 'primary' | 'ghost' | 'danger';
		disabled?: boolean;
		full?: boolean;
		onclick?: () => void;
		children: Snippet;
	}

	let {
		type = 'button',
		variant = 'primary',
		disabled = false,
		full = false,
		onclick,
		children
	}: Props = $props();

	const variants: Record<string, string> = {
		primary: 'bg-accent text-black hover:bg-accent-hover',
		ghost: 'bg-transparent text-muted hover:text-text hover:bg-surface-2',
		danger: 'bg-transparent text-danger hover:bg-surface-2'
	};
</script>

<button
	{type}
	{disabled}
	{onclick}
	class="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 {variants[
		variant
	]} {full ? 'w-full' : ''}"
>
	{@render children()}
</button>
