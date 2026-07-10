// Google Identity Services (GIS) OAuth token client (PLAN.md §7). Popup/token
// flow — no redirect URI, no client secret. The access token lives only in
// memory (held by the caller); it is never persisted.

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface TokenResponse {
	access_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

export interface AccessToken {
	token: string;
	/** Seconds until the token expires (typically ~3600). */
	expiresIn: number;
}
interface TokenError {
	type?: string;
	message?: string;
}
interface TokenClient {
	requestAccessToken(overrides?: { prompt?: string }): void;
}
interface Gis {
	accounts: {
		oauth2: {
			initTokenClient(config: {
				client_id: string;
				scope: string;
				callback: (response: TokenResponse) => void;
				error_callback?: (error: TokenError) => void;
			}): TokenClient;
			revoke(token: string, done?: () => void): void;
		};
	};
}

/** '' = interactive (consent as needed); 'none' = silent (no UI, errors if interaction needed). */
export type Prompt = '' | 'none' | 'consent';

function gis(): Gis {
	const g = (globalThis as { google?: Gis }).google;
	if (!g) throw new Error('Google Identity Services not loaded');
	return g;
}

let loader: Promise<void> | null = null;
function loadGis(): Promise<void> {
	if (loader) return loader;
	loader = new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = GIS_SRC;
		script.async = true;
		script.defer = true;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
		document.head.appendChild(script);
	});
	return loader;
}

/**
 * Request a Drive access token. `prompt: ''` shows consent as needed; `'none'`
 * attempts a silent grant (no popup) and rejects if interaction is required.
 */
export async function requestAccessToken(clientId: string, prompt: Prompt = ''): Promise<AccessToken> {
	await loadGis();
	return new Promise<AccessToken>((resolve, reject) => {
		const client = gis().accounts.oauth2.initTokenClient({
			client_id: clientId,
			scope: DRIVE_SCOPE,
			callback: (response) => {
				if (response.access_token)
					resolve({ token: response.access_token, expiresIn: response.expires_in ?? 3600 });
				else reject(new Error(response.error_description ?? response.error ?? 'Authorization failed'));
			},
			error_callback: (error) => reject(new Error(error.message ?? error.type ?? 'Authorization failed'))
		});
		client.requestAccessToken({ prompt });
	});
}

export function revokeAccessToken(token: string): void {
	try {
		gis().accounts.oauth2.revoke(token);
	} catch {
		/* ignore */
	}
}
