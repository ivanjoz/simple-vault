// Central app state (Svelte 5 runes). Orchestrates the key Worker, the Dexie
// repository, and (later) Drive sync. Holds NO key material and no decrypted
// secret beyond card metadata; entry passwords are fetched on demand.

import { browser } from '$app/environment';
import { PUBLIC_GOOGLE_CLIENT_ID } from '$env/static/public';
import type { Bytes, VaultHeader } from '$lib/crypto';
import { base64ToBytes, bytesToBase64, unwrapDek, wrapDek } from '$lib/crypto';
import {
	META_DRIVE_FOLDER_IDS,
	META_DRIVE_FOLDER_VERSIONS,
	META_DRIVE_HEADER_ID,
	META_HEADER,
	META_LAST_SYNC,
	META_LOCAL_UNLOCK,
	VaultRepository
} from '$lib/db/repository';
import type { LocalUnlockKind, LocalUnlocker } from '$lib/unlock/types';
import { enrollWebAuthn, isPlatformAuthenticatorAvailable, unlockWebAuthn } from '$lib/unlock/webauthn';
import { derivePinKey, enrollPinKey } from '$lib/unlock/pin';
import { requestAccessToken } from '$lib/drive/auth';
import {
	createBinaryFile,
	createJsonFile,
	downloadBytes,
	downloadJson,
	findHeaderFile,
	folderFileName,
	folderIdFromFileName,
	HEADER_FILE_NAME,
	listVaultFiles,
	updateBinaryFile,
	updateJsonFile
} from '$lib/drive/client';
import { downloadBytes as downloadBinary } from '$lib/app/download';
import { copyWithAutoClear } from '$lib/session/clipboard';
import { mergeById } from '$lib/sync/delta';
import { KeyClient } from '$lib/worker/keyClient';
import type { CardView, Folder, HistoryItem, PlainRecord, SecretPlain } from '$lib/vault/types';
import type { StoredRecord } from '$lib/vault/types';
import { decodeFolderFile, encodeFolderFile } from '$lib/vault/folderFile';
import { createId, ROOT_FOLDER_ID, updatedNow } from '$lib/vault/record';
import { decodeBackup, encodeBackup } from '$lib/vault/backup';

export interface RecordInput {
	id?: string;
	folderId: string;
	title: string;
	username: string;
	password: string;
	url: string;
	notes: string;
}

const HISTORY_LIMIT = 50;
// sessionStorage key holding the DEK for the tab session (opt-in), and the
// localStorage flag for the preference (read synchronously at startup).
const SESSION_DEK_KEY = 'svault.session.dek';
const SESSION_TOKEN_KEY = 'svault.session.driveToken';
const PERSIST_PREF_KEY = 'svault.session.persist';

// Auto-lock policy: how long the app may sit in the background before it
// re-locks. Stored in localStorage as milliseconds; -1 means "never".
const AUTOLOCK_MS_KEY = 'svault.autolock.ms';
const HIDDEN_AT_KEY = 'svault.autolock.hiddenAt';
const DEFAULT_AUTOLOCK_MS = 30_000;
/** Preset options surfaced in Settings (label + ms; -1 = never). */
export const AUTOLOCK_OPTIONS: { label: string; ms: number }[] = [
	{ label: 'Immediately', ms: 0 },
	{ label: 'After 30 seconds', ms: 30_000 },
	{ label: 'After 1 minute', ms: 60_000 },
	{ label: 'After 5 minutes', ms: 300_000 },
	{ label: 'Never', ms: -1 }
];
/** Failed PIN attempts before the PIN path locks out (master password still works). */
const PIN_MAX_ATTEMPTS = 5;

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
	/** Enrolled device-local unlocker kind, or null if none is set up here. */
	localUnlockKind = $state<LocalUnlockKind | null>(null);
	/** Whether this device has a user-verifying platform authenticator (biometrics). */
	platformAuthAvailable = $state(false);
	/** Background auto-lock delay in ms (-1 = never). */
	autoLockMs = $state<number>(DEFAULT_AUTOLOCK_MS);
	#driveToken: string | null = null;
	#autoLockInstalled = false;

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
		this.autoLockMs = this.#readAutoLockMs();
		this.#installAutoLock();
		void this.#detectPlatformAuth();
		try {
			this.lastSync = (await this.repo.getMeta<number>(META_LAST_SYNC)) ?? null;
			await this.#loadLocalUnlockKind();

			// Resume if the DEK is still available: either a SharedWorker kept it,
			// or (opt-in) it was persisted in sessionStorage for this tab.
			if (await this.#resumeSession()) {
				// The worker's key can outlive the on-disk envelope (e.g. the user
				// cleared browser storage while a tab — and thus the SharedWorker —
				// stayed alive). Only resume if the envelope is actually still there;
				// otherwise the key is stale, so drop it and start clean. Also honour
				// the auto-lock policy: if the app spent longer than the configured
				// delay in the background, re-lock instead of silently resuming.
				const header = await this.repo.getMeta<VaultHeader>(META_HEADER);
				if (header && !this.#backgroundLockExpired()) {
					this.#clearHiddenAt();
					await this.loadCards();
					this.status = 'unlocked';
					void this.#trySilentConnect(); // reconnect token only — no sync on reload
					return;
				}
				await this.lock(); // stale key or auto-lock expired; falls through below
			}

			const header = await this.repo.getMeta<VaultHeader>(META_HEADER);
			this.status = header ? 'locked' : 'connect';
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
			const file = await findHeaderFile(token);
			if (file) {
				const header = await downloadJson<VaultHeader>(token, file.id);
				await this.repo.setMeta(META_HEADER, header);
				await this.repo.setMeta(META_DRIVE_HEADER_ID, file.id);
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
			const { header, recoveryKey } = await this.client.call('create', { masterPassword });
			await this.repo.setMeta(META_HEADER, header);
			const now = updatedNow();
			const { folders } = await this.client.call('encryptFolders', {
				folders: [{ id: ROOT_FOLDER_ID, name: '', updated: now, status: 'active' }]
			});
			await this.repo.putFolders(folders);
			// If Drive is connected, establish the remote vault file immediately.
			if (this.#driveToken) {
				const id = await createJsonFile(this.#driveToken, HEADER_FILE_NAME, header);
				await this.repo.setMeta(META_DRIVE_HEADER_ID, id);
				await this.#uploadFolder(ROOT_FOLDER_ID);
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
			const header = await this.repo.getMeta<VaultHeader>(META_HEADER);
			if (!header) {
				this.status = 'onboarding';
				return;
			}
			const { ok } = await this.client.call('unlock', { header, secret, method });
			if (!ok) {
				this.error =
					method === 'password' ? 'Incorrect master password.' : 'Invalid recovery key.';
				return;
			}
			await this.#finishUnlock();
		} catch (err) {
			this.error = errorMessage(err);
		} finally {
			this.busy = false;
		}
	}

	/** Shared post-unlock hydration path (used by password, recovery and local unlock). */
	async #finishUnlock(): Promise<void> {
		this.#clearHiddenAt();
		await this.#decryptCachedFolderNames();
		await this.loadCards();
		this.status = 'unlocked';
		void this.#saveSession();
		void this.#syncAfterUnlock(); // one full sync on a real unlock
	}

	async lock(): Promise<void> {
		await this.client.call('lock', {});
		this.#clearSession();
		this.#clearHiddenAt();
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

	// --- Device-local unlock (biometrics / PIN) ------------------------------

	async #detectPlatformAuth(): Promise<void> {
		this.platformAuthAvailable = await isPlatformAuthenticatorAvailable();
	}

	async #loadLocalUnlockKind(): Promise<void> {
		const unlocker = await this.repo.getMeta<LocalUnlocker>(META_LOCAL_UNLOCK);
		this.localUnlockKind = unlocker ? unlocker.kind : null;
	}

	/** Raw DEK bytes for wrapping under a biometric/PIN key. Requires an unlocked vault. */
	async #exportDekBytes(): Promise<Bytes> {
		const { dek } = await this.client.call('exportDek', {});
		return base64ToBytes(dek);
	}

	/** Enrol this device's platform authenticator (fingerprint/face/PIN) as an unlocker. */
	async enrollBiometric(): Promise<boolean> {
		this.busy = true;
		this.error = null;
		try {
			const enrollment = await enrollWebAuthn();
			if (!enrollment) {
				this.error = "This device can't be used to unlock the app (no supported authenticator).";
				return false;
			}
			const dek = await this.#exportDekBytes();
			const wrappedDek = await wrapDek(dek, enrollment.key);
			dek.fill(0);
			const unlocker: LocalUnlocker = {
				kind: 'webauthn',
				credentialId: enrollment.credentialId,
				prfSalt: enrollment.prfSalt,
				wrappedDek
			};
			await this.repo.setMeta(META_LOCAL_UNLOCK, unlocker);
			this.localUnlockKind = 'webauthn';
			return true;
		} catch (err) {
			this.error = errorMessage(err);
			return false;
		} finally {
			this.busy = false;
		}
	}

	/** Enrol a PIN/pattern as this device's unlocker. Requires an unlocked vault. */
	async enrollPin(pin: string): Promise<boolean> {
		this.busy = true;
		this.error = null;
		try {
			const setup = await enrollPinKey(pin);
			const dek = await this.#exportDekBytes();
			const wrappedDek = await wrapDek(dek, setup.key);
			dek.fill(0);
			const unlocker: LocalUnlocker = {
				kind: 'pin',
				salt: setup.salt,
				kdf: setup.kdf,
				wrappedDek,
				attempts: 0
			};
			await this.repo.setMeta(META_LOCAL_UNLOCK, unlocker);
			this.localUnlockKind = 'pin';
			return true;
		} catch (err) {
			this.error = errorMessage(err);
			return false;
		} finally {
			this.busy = false;
		}
	}

	/** Remove this device's biometric/PIN unlocker. */
	async disableLocalUnlock(): Promise<void> {
		await this.repo.deleteMeta(META_LOCAL_UNLOCK);
		this.localUnlockKind = null;
	}

	/**
	 * Unlock via the device-local unlocker. For biometrics `pin` is ignored (the
	 * authenticator prompts); for the PIN path the digits are required.
	 */
	async unlockLocal(pin?: string): Promise<void> {
		this.busy = true;
		this.error = null;
		try {
			const unlocker = await this.repo.getMeta<LocalUnlocker>(META_LOCAL_UNLOCK);
			if (!unlocker) {
				this.error = 'No app lock is set up on this device.';
				return;
			}

			let kek: CryptoKey;
			if (unlocker.kind === 'webauthn') {
				kek = await unlockWebAuthn(unlocker.credentialId, unlocker.prfSalt);
			} else {
				if (unlocker.attempts >= PIN_MAX_ATTEMPTS) {
					this.error = 'Too many attempts. Unlock with your master password.';
					return;
				}
				if (!pin) {
					this.error = 'Enter your PIN.';
					return;
				}
				kek = await derivePinKey(pin, unlocker.salt, unlocker.kdf);
			}

			let dekBytes: Bytes;
			try {
				dekBytes = await unwrapDek(unlocker.wrappedDek, kek);
			} catch {
				if (unlocker.kind === 'pin') {
					const attempts = unlocker.attempts + 1;
					await this.repo.setMeta(META_LOCAL_UNLOCK, { ...unlocker, attempts });
					const left = PIN_MAX_ATTEMPTS - attempts;
					this.error =
						left > 0
							? `Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} left.`
							: 'Too many attempts. Unlock with your master password.';
				} else {
					this.error = 'Could not unlock with this device.';
				}
				return;
			}

			const dekB64 = bytesToBase64(dekBytes);
			dekBytes.fill(0);
			const { ok } = await this.client.call('restoreDek', { dek: dekB64 });
			if (!ok) {
				this.error = 'Failed to restore the vault key.';
				return;
			}
			if (unlocker.kind === 'pin' && unlocker.attempts) {
				await this.repo.setMeta(META_LOCAL_UNLOCK, { ...unlocker, attempts: 0 });
			}
			await this.#finishUnlock();
		} catch (err) {
			this.error = errorMessage(err);
		} finally {
			this.busy = false;
		}
	}

	// --- Auto-lock -----------------------------------------------------------

	setAutoLockMs(ms: number): void {
		this.autoLockMs = ms;
		if (browser) localStorage.setItem(AUTOLOCK_MS_KEY, String(ms));
	}

	#readAutoLockMs(): number {
		const raw = localStorage.getItem(AUTOLOCK_MS_KEY);
		if (raw === null) return DEFAULT_AUTOLOCK_MS;
		const n = Number(raw);
		return Number.isFinite(n) ? n : DEFAULT_AUTOLOCK_MS;
	}

	#installAutoLock(): void {
		if (this.#autoLockInstalled || !browser) return;
		this.#autoLockInstalled = true;
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') this.#onHidden();
			else this.#onVisible();
		});
	}

	#onHidden(): void {
		if (this.autoLockMs < 0) return; // never
		if (browser) localStorage.setItem(HIDDEN_AT_KEY, String(Date.now()));
		// Immediate policy: drop the key the moment we lose focus.
		if (this.autoLockMs === 0 && this.status === 'unlocked') void this.lock();
	}

	#onVisible(): void {
		if (this.status === 'unlocked' && this.#backgroundLockExpired()) void this.lock();
		else this.#clearHiddenAt();
	}

	/** True if the app was backgrounded longer than the configured auto-lock delay. */
	#backgroundLockExpired(): boolean {
		if (this.autoLockMs < 0 || !browser) return false;
		const raw = localStorage.getItem(HIDDEN_AT_KEY);
		if (!raw) return false;
		const hiddenAt = Number(raw);
		if (!Number.isFinite(hiddenAt)) return false;
		return Date.now() - hiddenAt >= this.autoLockMs;
	}

	#clearHiddenAt(): void {
		if (browser) localStorage.removeItem(HIDDEN_AT_KEY);
	}

	dismissRecoveryKey(): void {
		this.recoveryKeyOnce = null;
	}

	/** Load active records' metadata (title/username) for card rendering. */
	async loadCards(): Promise<void> {
		const records = await this.repo.activeRecords();
		const { metas } = await this.client.call('decryptMetas', { records });
		this.cards = records.map((r, i) => ({
			id: r.id,
			folderId: r.folderId === ROOT_FOLDER_ID ? '' : r.folderId,
			updated: r.updated,
			title: metas[i].title,
			username: metas[i].username
		}));
		this.folders = (await this.repo.activeFolders()).filter((folder) => folder.id !== ROOT_FOLDER_ID);
	}

	/** Decrypt one entry's password and copy it, clearing after the 40 s TTL. */
	async copyPassword(id: string): Promise<void> {
		const record = await this.repo.getRecord(id);
		if (!record) return;
		const { secret } = await this.client.call('decryptSecret', { record });
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
		const { secret } = await this.client.call('decryptSecret', { record });
		return secret;
	}

	/** Decrypt password history only for an explicit reveal/edit that needs it. */
	async getHistory(id: string): Promise<HistoryItem[]> {
		const record = await this.repo.getRecord(id);
		if (!record) return [];
		return (await this.client.call('decryptHistory', { record })).history;
	}

	/** Create or update a record, maintaining password history on change. */
	async saveRecord(input: RecordInput): Promise<void> {
		const now = updatedNow();
		const id = input.id ?? createId();
		const folderId = input.folderId || ROOT_FOLDER_ID;
		let history: HistoryItem[] = [];
		let password = input.password;
		let previousFolderId: string | null = null;
		let existing: StoredRecord | undefined;
		let historyChanged = false;

		if (input.id) {
			existing = await this.repo.getRecord(input.id);
			if (existing) {
				previousFolderId = existing.folderId;
				const { secret } = await this.client.call('decryptSecret', { record: existing });
				if (input.password === '') {
					// Blank means "keep the current password" (the editor never held it).
					password = secret.password;
				} else if (secret.password !== input.password) {
					history = (await this.client.call('decryptHistory', { record: existing })).history;
					history = [{ p: secret.password, u: existing.updated }, ...history].slice(0, HISTORY_LIMIT);
					historyChanged = true;
				}
				if (existing.folderId !== folderId && !historyChanged && existing.enc_history) {
					history = (await this.client.call('decryptHistory', { record: existing })).history;
				}
			}
		}

		const plain: PlainRecord = {
			id,
			folderId,
			updated: now,
			status: 'active',
			title: input.title,
			username: input.username,
			password,
			url: input.url,
			notes: input.notes,
			history,
			historyUpdated: historyChanged ? now : existing?.historyUpdated
		};
		const { stored } = await this.client.call('encryptRecords', { records: [plain] });
		if (existing?.enc_history && !historyChanged && existing.folderId === folderId) {
			stored[0].enc_history = existing.enc_history;
			stored[0].historyUpdated = existing.historyUpdated;
		}
		await this.repo.putRecords(stored);
		await this.#uploadFolder(folderId);
		if (previousFolderId && previousFolderId !== folderId) await this.#uploadFolder(previousFolderId);
		await this.loadCards();
	}

	/** Soft-delete a record via a tombstone (propagates on sync). */
	async deleteRecord(id: string): Promise<void> {
		const existing = await this.repo.getRecord(id);
		if (!existing) return;
		const [{ metas }, { secret }] = await Promise.all([
			this.client.call('decryptMetas', { records: [existing] }),
			this.client.call('decryptSecret', { record: existing })
		]);
		const tombstone: PlainRecord = {
			id: existing.id,
			folderId: existing.folderId,
			updated: updatedNow(),
			status: 'deleted',
			title: metas[0].title,
			username: metas[0].username,
			password: secret.password,
			url: secret.url,
			notes: secret.notes,
			history: []
		};
		await this.repo.putRecords((await this.client.call('encryptRecords', { records: [tombstone] })).stored);
		await this.#uploadFolder(existing.folderId);
		await this.loadCards();
	}

	async addFolder(name: string): Promise<string> {
		const folder: Folder = { id: createId(), name, updated: updatedNow(), status: 'active' };
		const { folders } = await this.client.call('encryptFolders', { folders: [folder] });
		await this.repo.putFolders(folders);
		await this.#uploadFolder(folder.id);
		this.folders = (await this.repo.activeFolders()).filter((item) => item.id !== ROOT_FOLDER_ID);
		return folder.id;
	}

	/** Connect Drive (if needed) and run a full two-way sync. */
	async syncNow(): Promise<void> {
		this.syncing = true;
		this.syncError = null;
		try {
			const token = this.#driveToken ?? (await this.#connectDrive());
			const header = await this.repo.getMeta<VaultHeader>(META_HEADER);
			if (!header) return;
			const files = await listVaultFiles(token);
			const headerFile = files.find((file) => file.name === HEADER_FILE_NAME);
			if (headerFile) await this.repo.setMeta(META_DRIVE_HEADER_ID, headerFile.id);
			else await this.#uploadHeader(header);

			const ids: Record<string, string> = {};
			const versions: Record<string, string> = {};
			const remoteBytes = new Map<string, Bytes>();
			let remoteRecords: StoredRecord[] = [];
			for (const file of files) {
				const folderId = folderIdFromFileName(file.name);
				if (!folderId) continue;
				ids[folderId] = file.id;
				if (file.version) versions[folderId] = file.version;
				const bytes = await downloadBytes(token, file.id);
				remoteBytes.set(folderId, bytes);
				const decoded = decodeFolderFile(bytes);
				if (decoded.folder.id !== folderId) throw new Error('folder filename/content mismatch');
				const { folders } = await this.client.call('decryptFolders', { folders: [decoded.folder] });
				const localFolder = await this.repo.getFolder(folderId);
				await this.repo.putFolders(mergeById(localFolder ? [localFolder] : [], folders));
				remoteRecords = mergeStoredRecords(remoteRecords, decoded.records);
			}
			await this.repo.putRecords(mergeStoredRecords(await this.repo.allRecords(), remoteRecords));
			await this.repo.setMeta(META_DRIVE_FOLDER_IDS, ids);
			await this.repo.setMeta(META_DRIVE_FOLDER_VERSIONS, versions);

			// Upload only folder files whose merged binary content differs from Drive.
			for (const folder of await this.repo.allFolders()) {
				const bytes = encodeFolderFile(folder, await this.repo.recordsForFolder(folder.id));
				const remote = remoteBytes.get(folder.id);
				if (!remote || !sameBytes(bytes, remote)) await this.#uploadFolder(folder.id);
			}

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
			const header = await this.repo.getMeta<VaultHeader>(META_HEADER);
			if (!header) return false;
			const [stored, folders] = await Promise.all([
				this.repo.allRecords(),
				this.repo.allFolders()
			]);
			const res = await this.client.call('changeMasterPassword', {
				newPassword,
				currentHeader: header,
				stored,
				folders
			});
			await this.repo.putRecords(res.stored); // re-encrypted with the new DEK
			await this.repo.putFolders(res.folders);
			await this.repo.setMeta(META_HEADER, res.header);
			await this.#saveSession(); // DEK changed → refresh persisted copy
			// The DEK rotated, so any biometric/PIN unlocker now wraps the old key.
			// Drop it; the user must re-enable app lock (it'll re-wrap the new DEK).
			if (this.localUnlockKind) await this.disableLocalUnlock();
			await this.#uploadHeader(res.header);
			for (const folder of res.folders) await this.#uploadFolder(folder.id);
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
			const header = await this.repo.getMeta<VaultHeader>(META_HEADER);
			if (!header) return false;
			const res = await this.client.call('regenerateRecoveryKey', { currentHeader: header });
			await this.repo.setMeta(META_HEADER, res.header);
			await this.#uploadHeader(res.header);
			this.recoveryKeyOnce = res.recoveryKey;
			return true;
		} catch (err) {
			this.error = errorMessage(err);
			return false;
		} finally {
			this.busy = false;
		}
	}

	/** Download a binary v2 backup. Folder bytes are copied without Base64. */
	async exportVault(): Promise<void> {
		const header = await this.repo.getMeta<VaultHeader>(META_HEADER);
		if (!header) return;
		const folders: Bytes[] = [];
		for (const folder of await this.repo.allFolders()) {
			folders.push(encodeFolderFile(folder, await this.repo.recordsForFolder(folder.id)));
		}
		downloadBinary('simple-vault-backup.svault', encodeBackup(header, folders));
	}

	/** Validate and replace local data with an imported v2 backup, then re-lock. */
	async importVault(bytes: Bytes): Promise<void> {
		const bundle = decodeBackup(bytes);
		const decoded = bundle.folders.map(decodeFolderFile);
		await this.repo.clear();
		this.localUnlockKind = null; // the imported vault has a different DEK
		await this.repo.setMeta(META_HEADER, bundle.header);
		for (const item of decoded) {
			await this.repo.putFolders([item.folder]);
			await this.repo.putRecords(item.records);
		}
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
		this.localUnlockKind = null;
		this.cards = [];
		this.folders = [];
		this.disconnectDrive();
		this.settingsOpen = false;
		this.status = 'connect';
	}

	async #uploadHeader(header: VaultHeader): Promise<void> {
		if (!this.#driveToken) return;
		const fileId = await this.repo.getMeta<string>(META_DRIVE_HEADER_ID);
		if (fileId) await updateJsonFile(this.#driveToken, fileId, header);
		else {
			await this.repo.setMeta(
				META_DRIVE_HEADER_ID,
				await createJsonFile(this.#driveToken, HEADER_FILE_NAME, header)
			);
		}
	}

	async #uploadFolder(folderId: string): Promise<void> {
		if (!this.#driveToken) return;
		let folder = await this.repo.getFolder(folderId);
		if (!folder) return;
		if (!folder.enc_name) {
			folder = (await this.client.call('encryptFolders', { folders: [folder] })).folders[0];
			await this.repo.putFolders([folder]);
		}
		const bytes = encodeFolderFile(folder, await this.repo.recordsForFolder(folderId));
		const ids = (await this.repo.getMeta<Record<string, string>>(META_DRIVE_FOLDER_IDS)) ?? {};
		if (ids[folderId]) await updateBinaryFile(this.#driveToken, ids[folderId], bytes);
		else {
			ids[folderId] = await createBinaryFile(
				this.#driveToken,
				folderFileName(folderId),
				bytes
			);
			await this.repo.setMeta(META_DRIVE_FOLDER_IDS, ids);
		}
	}

	async #decryptCachedFolderNames(): Promise<void> {
		const encrypted = (await this.repo.allFolders()).filter((folder) => folder.enc_name);
		if (!encrypted.length) return;
		await this.repo.putFolders((await this.client.call('decryptFolders', { folders: encrypted })).folders);
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
}

export const vault = new VaultState();

/** Merge main record state and independently encrypted history by `updated`. */
function mergeStoredRecords(local: StoredRecord[], remote: StoredRecord[]): StoredRecord[] {
	const ids = new Set([...local.map((item) => item.id), ...remote.map((item) => item.id)]);
	const localById = new Map(local.map((item) => [item.id, item]));
	const remoteById = new Map(remote.map((item) => [item.id, item]));
	const merged: StoredRecord[] = [];
	for (const id of ids) {
		const left = localById.get(id);
		const right = remoteById.get(id);
		if (!left) {
			merged.push(right!);
			continue;
		}
		if (!right) {
			merged.push(left);
			continue;
		}
		const main = right.updated > left.updated ? right : left;
		if (main.status === 'deleted') {
			merged.push({ ...main, enc_history: undefined, historyUpdated: undefined });
			continue;
		}
		const leftHistory = left.historyUpdated ?? -1;
		const rightHistory = right.historyUpdated ?? -1;
		const history = rightHistory > leftHistory ? right : left;
		merged.push({
			...main,
			enc_history: history.enc_history,
			historyUpdated: history.historyUpdated
		});
	}
	return merged;
}

function sameBytes(left: Bytes, right: Bytes): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
