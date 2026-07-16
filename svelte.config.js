import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		runes: true
	},
	kit: {
		// Pure client-side SPA: no server, Google Drive is the only backend.
		adapter: adapter({
			fallback: '404.html',
			precompress: false,
			strict: false
		})
	}
};

export default config;
