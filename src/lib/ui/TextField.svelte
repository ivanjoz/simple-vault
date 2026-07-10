<script lang="ts">
	interface Props {
		label: string;
		value: string;
		type?: 'text' | 'password';
		placeholder?: string;
		autocomplete?: string;
		mono?: boolean;
		onenter?: () => void;
	}

	let {
		label,
		value = $bindable(''),
		type = 'text',
		placeholder = '',
		autocomplete,
		mono = false,
		onenter
	}: Props = $props();

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && onenter) onenter();
	}
</script>

<label class="flex flex-col gap-1.5">
	<span class="text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
	<input
		{type}
		{placeholder}
		{autocomplete}
		{onkeydown}
		bind:value
		class="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text outline-none transition-colors focus:border-accent {mono
			? 'font-mono tracking-wider'
			: ''}"
	/>
</label>
