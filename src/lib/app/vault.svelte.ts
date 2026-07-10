// Central app state (Svelte 5 runes). Orchestrates the key Worker, the Dexie
// repository, and (later) Drive sync. Holds NO key material and no decrypted
// secret beyond card metadata; entry passwords are fetched on demand.

import { browser } from '$app/environment';
import { PUBLIC_GOOGLE_CLIENT_ID } from '$env/static/public';
import type { VaultEnvelope } from '$lib/crypto';
import {
	META_DRIVE_FILE_ID,
	META_ENVELOPE,
	META_LAST_SYNC,
	VaultRepository
} from '$lib/db/repository';
import { requestAccessToken } from '$lib/drive/auth';
import { createVaultFile, downloadJson, findVaultFile, updateFile } from '$lib/drive/client';
import { downloadText } from '$lib/app/download';
import { copyWithAutoClear } from '$lib/session/clipboard';
import { mergeById } from '$lib/sync/delta';
import { KeyClient } from '$lib/worker/keyClient';
import type { CardView, Folder, HistoryItem, PlainRecord, SecretPlain } from '$lib/vault/types';

export interface RecordInput {
	id?: string;
	folderId: string;
	title: string;
	username: string;
	password: string;
	notes: string;
}

const HISTORY_LIMIT = 50;
// sessionStorage key holding the DEK for the tab session (opt-in), and the
// localStorage flag for the preference (read synchronously at startup).
const SESSION_DEK_KEY = 'svault.session.dek';
const SESSION_TOKEN_KEY = 'svault.session.driveToken';
const PERSIST_PREF_KEY = 'svault.session.persist';

export type VaultStatus = 'loading' | 'connect' | 'onboarding' | 'locked' | 'unlocked';
export type UnlockMethod = 'password' | 'recovery';

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

class VaultState {
	status = $state<VaultStatus>('loading');
	error = $state<string | null>(null);
	busy = $state(false);
	cards = $state<CardView[]>([]);
	folders = $state<Folder[]>([]);
	/** Set once right after vault creation so the UI can show + offer it for download. */
	recoveryKeyOnce = $state<string | null>(null);

	// UI filter state.
	search = $state('');
	selectedFolderId = $state<string | null>(null);
	/** Id of the card whose password was just copied (for transient feedback). */
	copiedId = $state<string | null>(null);

	// Google Drive sync state. The access token is memory-only (never persisted).
	driveConnected = $state(false);
	syncing = $state(false);
	syncError = $state<string | null>(null);
	lastSync = $state<number | null>(null);
	/** Keep the tab unlocked across reloads via sessionStorage (opt-in, default on). */
	persistSession = $state(true);
	/** Whether the settings panel is open. */
	settingsOpen = $state(false);
	#driveToken: string | null = null;

	visibleCards = $derived.by(() => {
		const q = this.search.trim().toLowerCase();
		return this.cards.filter((c) => {
			if (this.selectedFolderId && c.folderId !== this.selectedFolderId) return false;
			if (!q) return true;
			return c.title.toLowerCase().includes(q) || c.username.toLowerCase().includes(q);
		});
	});

	#client: KeyClient | null = null;
	#repo: VaultRepository | null = null;

	get client(): KeyClient {
		return (this.#client ??= new KeyClient());
	}
	get repo(): VaultRepository {
		return (this.#repo ??= new VaultRepository());
	}

	/**
	 * Decide the initial screen. If a vault is cached locally we unlock offline;
	 * otherwise we ask the user to connect Drive so we can look for an existing
	 * vault before offering to create a new one (PLAN.md §6 / §7).
	 */
	async init(): Promise<void> {
		if (!browser) return;
		this.persistSession = localStorage.getItem(PERSIST_PREF_KEY) !== '0';
		try {
			this.lastSync = (await this.repo.getMeta<number>(META_LAST_SYNC)) ?? null;

			// Resume if the DEK is still available: either a SharedWorker kept it,
			// or (opt-in) it was persisted in sessionStorage for this tab.
			if (await this.#resumeSession()) {
				await this.loadCards();
				this.status = 'unlocked';
				void this.#trySilentConnect(); // reconnect token only — no sync on reload
				return;
			}

			const envelope = await this.repo.getMeta<VaultEnvelope>(META_ENVELOPE);
			this.status = envelope ? 'locked' : 'connect';
		} catch (err) {
			this.error = errorMessage(err);
			this.status = 'connect';
		}
	}

	/** Connect Drive at startup and route based on whether a vault already exists. */
	async connectAtStartup(): Promise<void> {
		this.busy = true;
		this.error = null;
		try {
			const token = await this.#connectDrive();
			const file = await findVaultFile(token);
			if (file) {
				const envelope = await downloadJson<VaultEnvelope>(token, file.id);
				await this.repo.setMeta(META_ENVELOPE, envelope);
				await this.repo.setMeta(META_DRIVE_FILE_ID, file.id);
				this.status = 'locked';
			} else {
				this.status = 'onboarding';
			}
		} catch (err) {
			this.error = errorMessage(err);
		} finally {
			this.busy = false;
		}
	}

	/** Skip Drive for now and create a local-only vault (can connect later). */
	setupLocally(): void {
		this.error = null;
		this.status = 'onboarding';
	}

	async createVault(masterPassword: string): Promise<void> {
		this.busy = true;
		this.error = null;
		try {
			const { envelope, recoveryKey } = await this.client.call('create', { masterPassword });
			await this.repo.setMeta(META_ENVELOPE, envelope);
			// If Drive is connected, establish the remote vault file immediately.
			if (this.#driveToken) {
				const id = await createVaultFile(this.#driveToken, envelope);
				await this.repo.setMeta(META_DRIVE_FILE_ID, id);
			}
			this.recoveryKeyOnce = recoveryKey;
			await this.loadCards();
			this.status = 'unlocked';
			void this.#saveSession();
		} catch (err) {
			this.error = errorMessage(err);
		} finally {
			this.busy = false;
		}
	}

	async unlock(secret: string, method: UnlockMethod = 'password'): Promise<void> {
		this.busy = true;
		this.error = null;
		try {
			const envelope = await this.repo.getMeta<VaultEnvelope>(META_ENVELOPE);
			if (!envelope) {
				this.status = 'onboarding';
				return;
			}
			const { ok } = await this.client.call('unlock', { envelope, secret, method });
			if (!ok) {
				this.error =
					method === 'password' ? 'Incorrect master password.' : 'Invalid recovery key.';
				return;
			}
			await this.hydrateFromEnvelope();
			await this.loadCards();
			this.status = 'unlocked';
			void this.#saveSession();
			void this.#syncAfterUnlock(); // one full sync on a real unlock
		} catch (err) {
			this.error = errorMessage(err);
		} finally {
			this.busy = false;
		}
	}

	async lock(): Promise<void> {
		await this.client.call('lock', {});
		this.#clearSession();
		this.cards = [];
		this.folders = [];
		this.recoveryKeyOnce = null;
		this.error = null;
		this.status = 'locked';
	}

	/** Enable/disable keeping the tab unlocked across reloads (sessionStorage). */
	setPersistSession(enabled: boolean): void {
		this.persistSession = enabled;
		if (browser) localStorage.setItem(PERSIST_PREF_KEY, enabled ? '1' : '0');
		if (enabled) void this.#saveSession();
		else this.#clearSession();
	}

	/** True if the DEK is available (SharedWorker still holds it, or restore succeeds). */
	async #resumeSession(): Promise<boolean> {
		const { unlocked } = await this.client.call('status', {});
		if (unlocked) return true;
		if (!this.persistSession) return false;
		const saved = sessionStorage.getItem(SESSION_DEK_KEY);
		if (!saved) return false;
		const { ok } = await this.client.call('restoreDek', { dek: saved });
		if (!ok) sessionStorage.removeItem(SESSION_DEK_KEY);
		return ok;
	}

	async #saveSession(): Promise<void> {
		if (!browser || !this.persistSession) return;
		try {
			const { dek } = await this.client.call('exportDek', {});
			sessionStorage.setItem(SESSION_DEK_KEY, dek);
		} catch {
			/* ignore — persistence is best-effort */
		}
	}

	#clearSession(): void {
		if (browser) sessionStorage.removeItem(SESSION_DEK_KEY);
	}

	dismissRecoveryKey(): void {
		this.recoveryKeyOnce = null;
	}

	/** Load active records' metadata (title/username) for card rendering. */
	async loadCards(): Promise<void> {
		const records = await this.repo.activeRecords();
		const { metas } = await this.client.call('decryptMetas', {
			items: records.map((r) => r.enc_meta)
		});
		this.cards = records.map((r, i) => ({
			id: r.id,
			folderId: r.folderId,
			updated: r.updated,
			title: metas[i].title,
			username: metas[i].username
		}));
		this.folders = await this.repo.activeFolders();
	}

	/** Decrypt one entry's password and copy it, clearing after the 40 s TTL. */
	async copyPassword(id: string): Promise<void> {
		const record = await this.repo.getRecord(id);
		if (!record) return;
		const { secret } = await this.client.call('decryptSecret', { blob: record.enc_secret });
		const handle = copyWithAutoClear(secret.password);
		await handle.written;
		this.copiedId = id;
		setTimeout(() => {
			if (this.copiedId === id) this.copiedId = null;
		}, 1500);
	}

	/**
	 * Decrypt an entry's secret for the detail/edit view. The caller is
	 * responsible for dropping it (and does so on the 40 s reveal timer).
	 */
	async getSecret(id: string): Promise<SecretPlain | null> {
		const record = await this.repo.getRecord(id);
		if (!record) return null;
		const { secret } = await this.client.call('decryptSecret', { blob: record.enc_secret });
		return secret;
	}

	/** Create or update a record, maintaining password history on change. */
	async saveRecord(input: RecordInput): Promise<void> {
		const now = Date.now();
		const id = input.id ?? crypto.randomUUID();
		let history: HistoryItem[] = [];
		let password = input.password;

		if (input.id) {
			const existing = await this.repo.getRecord(input.id);
			if (existing) {
				const { secret } = await this.client.call('decryptSecret', { blob: existing.enc_secret });
				history = secret.history;
				if (input.password === '') {
					// Blank means "keep the current password" (the editor never held it).
					password = secret.password;
				} else if (secret.password !== input.password) {
					history = [{ p: secret.password, u: existing.updated }, ...history].slice(0, HISTORY_LIMIT);
				}
			}
		}

		const plain: PlainRecord = {
			id,
			folderId: input.folderId,
			updated: now,
			status: 'active',
			title: input.title,
			username: input.username,
			password,
			notes: input.notes,
			history
		};
		const { stored } = await this.client.call('encryptRecords', { records: [plain] });
		await this.repo.putRecords(stored);
		await this.persist();
		await this.loadCards();
	}

	/** Soft-delete a record via a tombstone (propagates on sync). */
	async deleteRecord(id: string): Promise<void> {
		const existing = await this.repo.getRecord(id);
		if (!existing) return;
		await this.repo.putRecords([{ ...existing, status: 'deleted', updated: Date.now() }]);
		await this.persist();
		await this.loadCards();
	}

	async addFolder(name: string): Promise<string> {
		const folder: Folder = { id: crypto.randomUUID(), name, updated: Date.now(), status: 'active' };
		await this.repo.putFolders([folder]);
		await this.persist();
		this.folders = await this.repo.activeFolders();
		return folder.id;
	}

	/** Populate IndexedDB records from the cached envelope's ciphertext (delta). */
	private async hydrateFromEnvelope(): Promise<void> {
		const envelope = await this.repo.getMeta<VaultEnvelope>(META_ENVELOPE);
		if (!envelope) return;
		const localUpdated = await this.repo.localUpdatedMap();
		const { stored, folders } = await this.client.call('ingestCiphertext', {
			blob: envelope.ciphertext,
			localUpdated
		});
		await this.repo.putRecords(stored);
		await this.repo.putFolders(mergeById(await this.repo.allFolders(), folders));
	}

	/** Connect Drive (if needed) and run a full two-way sync. */
	async syncNow(): Promise<void> {
		this.syncing = true;
		this.syncError = null;
		try {
			const token = this.#driveToken ?? (await this.#connectDrive());
			const envelope = await this.repo.getMeta<VaultEnvelope>(META_ENVELOPE);
			if (!envelope) return;

			// Locate the remote file (prefer the cached id).
			let fileId = await this.repo.getMeta<string>(META_DRIVE_FILE_ID);
			if (!fileId) fileId = (await findVaultFile(token))?.id;

			// Pull: merge remote changes into IndexedDB (delta).
			if (fileId) {
				const remote = await downloadJson<VaultEnvelope>(token, fileId);
				const localUpdated = await this.repo.localUpdatedMap();
				const { stored, folders } = await this.client.call('ingestCiphertext', {
					blob: remote.ciphertext,
					localUpdated
				});
				await this.repo.putRecords(stored);
				await this.repo.putFolders(mergeById(await this.repo.allFolders(), folders));
			}

			// Push: rebuild the merged ciphertext and upload.
			const [records, folders] = await Promise.all([
				this.repo.allRecords(),
				this.repo.allFolders()
			]);
			const { blob } = await this.client.call('exportCiphertext', { stored: records, folders });
			envelope.ciphertext = blob;
			envelope.updated = Date.now();
			if (fileId) await updateFile(token, fileId, envelope);
			else await this.repo.setMeta(META_DRIVE_FILE_ID, await createVaultFile(token, envelope));
			await this.repo.setMeta(META_ENVELOPE, envelope);

			const now = Date.now();
			await this.repo.setMeta(META_LAST_SYNC, now);
			this.lastSync = now;
			await this.loadCards();
		} catch (err) {
			this.syncError = errorMessage(err);
		} finally {
			this.syncing = false;
		}
	}

	/** Change the master password: rotate the DEK, re-encrypt everything, re-upload. */
	async changeMasterPassword(newPassword: string): Promise<boolean> {
		this.busy = true;
		this.error = null;
		try {
			const envelope = await this.repo.getMeta<VaultEnvelope>(META_ENVELOPE);
			if (!envelope) return false;
			const [stored, folders] = await Promise.all([
				this.repo.allRecords(),
				this.repo.allFolders()
			]);
			const res = await this.client.call('changeMasterPassword', {
				newPassword,
				currentEnvelope: envelope,
				stored,
				folders
			});
			await this.repo.putRecords(res.stored); // re-encrypted with the new DEK
			await this.repo.setMeta(META_ENVELOPE, res.envelope);
			await this.#saveSession(); // DEK changed → refresh persisted copy
			await this.#uploadEnvelope(res.envelope); // overwrite remote (no pull: it's stale-keyed)
			await this.loadCards();
			return true;
		} catch (err) {
			this.error = errorMessage(err);
			return false;
		} finally {
			this.busy = false;
		}
	}

	/** Issue a fresh recovery key (old one stops working) and show it once. */
	async regenerateRecoveryKey(): Promise<boolean> {
		this.busy = true;
		this.error = null;
		try {
			const envelope = await this.repo.getMeta<VaultEnvelope>(META_ENVELOPE);
			if (!envelope) return false;
			const res = await this.client.call('regenerateRecoveryKey', { currentEnvelope: envelope });
			await this.repo.setMeta(META_ENVELOPE, res.envelope);
			await this.#uploadEnvelope(res.envelope);
			this.recoveryKeyOnce = res.recoveryKey;
			return true;
		} catch (err) {
			this.error = errorMessage(err);
			return false;
		} finally {
			this.busy = false;
		}
	}

	/** Download the encrypted envelope as a backup file. */
	async exportVault(): Promise<void> {
		const envelope = await this.repo.getMeta<VaultEnvelope>(META_ENVELOPE);
		if (envelope) downloadText('simple-vault-backup.json', JSON.stringify(envelope, null, 2));
	}

	/** Replace the local vault with an imported encrypted envelope, then re-lock. */
	async importVault(json: string): Promise<void> {
		const envelope = JSON.parse(json) as VaultEnvelope;
		await this.repo.clear();
		await this.repo.setMeta(META_ENVELOPE, envelope);
		await this.lock();
	}

	/** Forget the Drive connection for this session (keeps local data). */
	disconnectDrive(): void {
		this.#driveToken = null;
		this.driveConnected = false;
		if (browser) sessionStorage.removeItem(SESSION_TOKEN_KEY);
	}

	/** Wipe everything local and start over. */
	async wipeLocal(): Promise<void> {
		await this.client.call('lock', {});
		this.#clearSession();
		await this.repo.clear();
		this.cards = [];
		this.folders = [];
		this.disconnectDrive();
		this.settingsOpen = false;
		this.status = 'connect';
	}

	async #uploadEnvelope(envelope: VaultEnvelope): Promise<void> {
		if (!this.#driveToken) return;
		const fileId = await this.repo.getMeta<string>(META_DRIVE_FILE_ID);
		if (fileId) await updateFile(this.#driveToken, fileId, envelope);
		else await this.repo.setMeta(META_DRIVE_FILE_ID, await createVaultFile(this.#driveToken, envelope));
	}

	async #connectDrive(prompt: '' | 'none' = ''): Promise<string> {
		const { token, expiresIn } = await requestAccessToken(PUBLIC_GOOGLE_CLIENT_ID, prompt);
		this.#driveToken = token;
		this.driveConnected = true;
		this.#cacheToken(token, expiresIn);
		return token;
	}

	/**
	 * Reconnect Drive without a popup. Reuses a cached, still-valid access token
	 * (so plain reloads make no Google call at all); only re-requests silently
	 * when the cached token is missing or expired. No sync.
	 */
	async #trySilentConnect(): Promise<void> {
		const cached = this.#loadCachedToken();
		if (cached) {
			this.#driveToken = cached;
			this.driveConnected = true;
			return;
		}
		try {
			await this.#connectDrive('none');
		} catch {
			/* not previously consented / no active Google session — stay offline */
		}
	}

	#cacheToken(token: string, expiresIn: number): void {
		if (!browser) return;
		const expiresAt = Date.now() + expiresIn * 1000;
		sessionStorage.setItem(SESSION_TOKEN_KEY, JSON.stringify({ t: token, e: expiresAt }));
	}

	#loadCachedToken(): string | null {
		if (!browser) return null;
		const raw = sessionStorage.getItem(SESSION_TOKEN_KEY);
		if (!raw) return null;
		try {
			const { t, e } = JSON.parse(raw) as { t: string; e: number };
			if (Date.now() < e - 30_000) return t; // 30s safety margin
		} catch {
			/* fall through to clear */
		}
		sessionStorage.removeItem(SESSION_TOKEN_KEY);
		return null;
	}

	/** On a real unlock, silently reconnect and run one full sync (if connected). */
	async #syncAfterUnlock(): Promise<void> {
		await this.#trySilentConnect();
		if (this.driveConnected) await this.syncNow();
	}

	/**
	 * Rebuild the encrypted envelope from local data and cache it (PLAN.md §6.2).
	 * This keeps the local envelope current; Drive upload happens on sync.
	 */
	private async persist(): Promise<void> {
		const [records, folders, envelope] = await Promise.all([
			this.repo.allRecords(),
			this.repo.allFolders(),
			this.repo.getMeta<VaultEnvelope>(META_ENVELOPE)
		]);
		if (!envelope) return;
		const { blob } = await this.client.call('exportCiphertext', { stored: records, folders });
		envelope.ciphertext = blob;
		envelope.updated = Date.now();
		await this.repo.setMeta(META_ENVELOPE, envelope);

		// Push the change to Drive if connected (lightweight upload, no pull).
		if (this.driveConnected) {
			try {
				await this.#uploadEnvelope(envelope);
				this.lastSync = envelope.updated;
				await this.repo.setMeta(META_LAST_SYNC, envelope.updated);
			} catch (err) {
				this.syncError = errorMessage(err);
			}
		}
	}
}

export const vault = new VaultState();
