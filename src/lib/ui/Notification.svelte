<script lang="ts">
	interface Props {
		title?: string;
		message: string;
		variant?: 'error' | 'success' | 'info';
		ondismiss?: () => void;
	}

	let {
		title,
		message,
		variant = 'info',
		ondismiss
	}: Props = $props();

	const styles = {
		error: {
			border: 'border-danger/45',
			icon: 'icon-[lucide--circle-alert] text-danger',
			title: 'Notification error'
		},
		success: {
			border: 'border-success/45',
			icon: 'icon-[lucide--circle-check] text-success',
			title: 'Notification success'
		},
		info: {
			border: 'border-accent/45',
			icon: 'icon-[lucide--info] text-accent',
			title: 'Notification'
		}
	} as const;

	let style = $derived(styles[variant]);
</script>

<div
	class="fixed right-16 bottom-16 left-16 z-[70] flex items-start gap-12 rounded-xl border bg-surface p-16 shadow-2xl sm:left-auto sm:w-360 {style.border}"
	role={variant === 'error' ? 'alert' : 'status'}
	aria-live={variant === 'error' ? 'assertive' : 'polite'}
>
	<span class="mt-2 size-20 shrink-0 {style.icon}" aria-hidden="true"></span>
	<div class="min-w-0 flex-1">
		<p class="text-sm font-semibold text-text">{title ?? style.title}</p>
		<p class="mt-4 text-sm leading-[20px] text-muted break-words">{message}</p>
	</div>
	{#if ondismiss}
		<button
			type="button"
			class="flex size-24 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
			aria-label="Dismiss notification"
			title="Dismiss"
			onclick={ondismiss}
		>
			<span class="icon-[lucide--x] size-16" aria-hidden="true"></span>
		</button>
	{/if}
</div>
