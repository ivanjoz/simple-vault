<script lang="ts">
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import '../app.css';
	import favicon from '$lib/assets/favicon.png';

	let { children } = $props();

	// SvelteKit builds the service worker but does not register it (it only
	// updates an existing one), so register it ourselves for offline support.
	onMount(() => {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js', {
				type: dev ? 'module' : 'classic'
			});
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Simple Vault</title>
</svelte:head>

{@render children()}
