<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		type?: 'button' | 'submit';
		variant?: 'primary' | 'ghost' | 'danger';
		size?: 'md' | 'sm';
		disabled?: boolean;
		full?: boolean;
		class?: string;
		onclick?: () => void;
		children: Snippet;
	}

	let {
		type = 'button',
		variant = 'primary',
		size = 'md',
		disabled = false,
		full = false,
		class: extra = '',
		onclick,
		children
	}: Props = $props();

	const variants: Record<string, string> = {
		primary: 'bg-accent text-black hover:bg-accent-hover',
		ghost: 'bg-transparent text-muted hover:text-text hover:bg-surface-2',
		danger: 'bg-transparent text-danger hover:bg-surface-2'
	};

	const sizes: Record<string, string> = {
		md: 'px-16 py-8',
		sm: 'px-10 py-8'
	};
</script>

<button
	{type}
	{disabled}
	{onclick}
	class="inline-flex items-center justify-center gap-8 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 {sizes[
		size
	]} {variants[variant]} {full ? 'w-full' : ''} {extra}"
>
	{@render children()}
</button>
