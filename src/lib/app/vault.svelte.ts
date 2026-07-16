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
	META_PENDING_RECORD_SYNCS,
	VaultRepository
} from '$lib/db/repository';
import type { LocalUnlockKind, LocalUnlocker } from '$lib/unlock/types';
import { enrollWebAuthn, isPlatformAuthenticatorAvailable, unlockWebAuthn } from '$lib/unlock/webauthn';
import { derivePinKey, enrollPinKey } from '$lib/unlock/pin';
import { requestAccessToken } from '$lib/drive/auth';
import {
	backupFileName,
	createBinaryFile,
	createJsonFile,
	deleteFile,
	downloadBytes,
	downloadJson,
	findHeaderFile,
	folderFileName,
	folderIdFromFileName,
	HEADER_FILE_NAME,
	listBackupFiles,
	listVaultFiles,
	updateBinaryFile,
	updateJsonFile
} from '$lib/drive/client';
import type { DriveFile } from '$lib/drive/client';
import { downloadBytes as downloadBinary, downloadText } from '$lib/app/download';
import { copyWithAutoClear } from '$lib/session/clipboard';
import { mergeById } from '$lib/sync/delta';
import { KeyClient } from '$lib/worker/keyClient';
import type { CardView, Folder, HistoryItem, PlainRecord, SecretPlain } from '$lib/vault/types';
import type { StoredRecord } from '$lib/vault/types';
import { decodeFolderFile, encodeFolderFile } from '$lib/vault/folderFile';
import { createId, ROOT_FOLDER_ID, updatedNow } from '$lib/vault/record';
import { decodeBackup, encodeBackup } from '$lib/vault/backup';
import type { BackupPreview } from '$lib/vault/backup';
import { BACKUP_FORMAT } from '$lib/vault/format';

export interface RecordInput {
	id?: string;
	folderId: string;
	title: string;
	username: string;
	password: string;
	url: string;
	notes: string;
}

interface RecoverableDriveFile {
	id: string;
	name: string;
	folderId: string;
}

const HISTORY_LIMIT = 50;
const DRIVE_BACKUP_LIMIT = 10;
const AUTO_SYNC_DEBOUNCE_MS = 60_000;
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
	/** Invalid remote folder file that may be explicitly replaced from the local cache. */
	recoverableDriveFile = $state<RecoverableDriveFile | null>(null);
	lastSync = $state<number | null>(null);
	/** Scheduled trailing autosync time, exposed for the sidebar countdown. */
	nextAutoSyncAt = $state<number | null>(null);
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
	#pendingRecordSyncs: Record<string, number> = {};
	#autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
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
			this.#pendingRecordSyncs =
				(await this.repo.getMeta<Record<string, number>>(META_PENDING_RECORD_SYNCS)) ?? {};
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
					// Reconnect without an unconditional reload sync; a persisted pending
					// change may resume its autosync countdown once the token is restored.
					void this.#trySilentConnect();
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
			const folders = await this.client.call('encryptFolders', [
				{ id: ROOT_FOLDER_ID, name: '', updated: now, status: 'active' }
			]);
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
		this.#cancelAutoSync();
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
		const { ok } = await this.client.call('restoreDek', { dek: base64ToBytes(saved) });
		if (!ok) sessionStorage.removeItem(SESSION_DEK_KEY);
		return ok;
	}

	async #saveSession(): Promise<void> {
		if (!browser || !this.persistSession) return;
		try {
			const { dek } = await this.client.call('exportDek', {});
			sessionStorage.setItem(SESSION_DEK_KEY, bytesToBase64(dek));
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
		return dek;
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

			const { ok } = await this.client.call('restoreDek', { dek: dekBytes });
			dekBytes.fill(0);
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
		// Older/incomplete local caches can contain records without their folder
		// row. Repair that invariant before any sync or backup can omit records.
		await this.#ensureFolderRows();
		const records = await this.repo.activeRecords();
		const metas = await this.client.call('decryptMetas', records);
		this.cards = records.map((r, i) => ({
			id: r.id,
			folderId: r.folderId === ROOT_FOLDER_ID ? '' : r.folderId,
			updated: r.updated,
			title: metas[i].title,
			username: metas[i].username,
			syncPending: this.#pendingRecordSyncs[r.id] !== undefined
		}));
		this.folders = (await this.repo.activeFolders()).filter((folder) => folder.id !== ROOT_FOLDER_ID);
	}

	/** Decrypt one entry's password and copy it, clearing after the 40 s TTL. */
	async copyPassword(id: string): Promise<void> {
		const record = await this.repo.getRecord(id);
		if (!record) return;
		const secret = await this.client.call('decryptSecret', record);
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
		return this.client.call('decryptSecret', record);
	}

	/** Decrypt password history only for an explicit reveal/edit that needs it. */
	async getHistory(id: string): Promise<HistoryItem[]> {
		const record = await this.repo.getRecord(id);
		if (!record) return [];
		return this.client.call('decryptHistory', record);
	}

	/** Create or update a record, maintaining password history on change. */
	async saveRecord(input: RecordInput): Promise<void> {
		const now = updatedNow();
		const id = input.id ?? createId();
		const folderId = input.folderId || ROOT_FOLDER_ID;
		let history: HistoryItem[] = [];
		let password = input.password;
		let historyChanged = false;
		const existing = input.id ? await this.repo.getRecord(input.id) : undefined;

		if (existing) {
			const secret = await this.client.call('decryptSecret', existing);
			if (input.password === '') {
				password = secret.password;
			} else if (secret.password !== input.password) {
				history = await this.client.call('decryptHistory', existing);
				history = [[secret.password, existing.updated], ...history].slice(0, HISTORY_LIMIT);
				historyChanged = true;
			}
			if (existing.folderId !== folderId && !historyChanged && existing.enc_history) {
				history = await this.client.call('decryptHistory', existing);
			}
		}

		const plain: PlainRecord = {
			id,
			folderId,
			updated: now,
			data: [input.title, input.username, password, input.url, input.notes],
			history,
			historyUpdated: historyChanged ? now : existing?.historyUpdated
		};
		const stored = await this.client.call('encryptRecords', [plain]);
		if (existing?.enc_history && !historyChanged && existing.folderId === folderId) {
			stored[0].enc_history = existing.enc_history;
			stored[0].historyUpdated = existing.historyUpdated;
		}
		await this.repo.putRecords(stored);
		await this.#markRecordPending(id);
		await this.loadCards();
		this.#scheduleAutoSync();
	}

	/** Soft-delete a record via a tombstone (propagates on sync). */
	async deleteRecord(id: string): Promise<void> {
		const existing = await this.repo.getRecord(id);
		if (!existing) return;
		await this.repo.putRecords([
			{ id: existing.id, folderId: existing.folderId, updated: updatedNow(), status: 'deleted' }
		]);
		await this.#markRecordPending(id);
		await this.loadCards();
		this.#scheduleAutoSync();
	}

	async addFolder(name: string): Promise<string> {
		const folder: Folder = { id: createId(), name, updated: updatedNow(), status: 'active' };
		const folders = await this.client.call('encryptFolders', [folder]);
		await this.repo.putFolders(folders);
		await this.#uploadFolder(folder.id);
		this.folders = (await this.repo.activeFolders()).filter((item) => item.id !== ROOT_FOLDER_ID);
		return folder.id;
	}

	/** Connect Drive (if needed) and run a full two-way sync. */
	async syncNow(): Promise<void> {
		if (this.syncing) return;
		this.#cancelAutoSync();
		this.syncing = true;
		this.syncError = null;
		this.recoverableDriveFile = null;
		try {
			const token = this.#driveToken ?? (await this.#connectDrive());
			// Changes made after this snapshot remain pending even if this sync succeeds.
			const pendingAtStart = { ...this.#pendingRecordSyncs };
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
				let decoded: ReturnType<typeof decodeFolderFile>;
				let folders: Folder[];
				try {
					decoded = decodeFolderFile(bytes);
					if (decoded.folder.id !== folderId) throw new Error('folder filename/content mismatch');
					folders = await this.client.call('decryptFolders', [decoded.folder]);
					await this.client.call('validateStoredRecords', decoded.records);
				} catch {
					this.recoverableDriveFile = { id: file.id, name: file.name, folderId };
					throw new Error(
						`Drive file “${file.name}” is not in the current Simple Vault format. ` +
							'It may be from an older version or be corrupted. If the local items are correct, replace this Drive file with the local data.'
					);
				}
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
			await this.#clearSyncedRecords(pendingAtStart);
			await this.loadCards();
			this.#scheduleAutoSync();
		} catch (err) {
			this.syncError = errorMessage(err);
		} finally {
			this.syncing = false;
		}
	}

	/** Explicitly overwrite a malformed remote folder file with its matching local data. */
	async replaceDriveFileWithLocalData(): Promise<void> {
		const remote = this.recoverableDriveFile;
		if (!remote || this.syncing) return;

		this.#cancelAutoSync();
		this.syncing = true;
		let replaced = false;
		try {
			const token = this.#driveToken ?? (await this.#connectDrive());
			let folder = await this.repo.getFolder(remote.folderId);
			if (!folder) {
				throw new Error(
					`Cannot replace “${remote.name}” because this device has no local data for that folder.`
				);
			}
			if (!folder.enc_name) {
				folder = (await this.client.call('encryptFolders', [folder]))[0];
				await this.repo.putFolders([folder]);
			}

			const bytes = encodeFolderFile(
				folder,
				await this.repo.recordsForFolder(remote.folderId)
			);
			await updateBinaryFile(token, remote.id, bytes);

			// Point future local uploads at the exact file the user chose to replace.
			const ids =
				(await this.repo.getMeta<Record<string, string>>(META_DRIVE_FOLDER_IDS)) ?? {};
			ids[remote.folderId] = remote.id;
			await this.repo.setMeta(META_DRIVE_FOLDER_IDS, ids);
			this.recoverableDriveFile = null;
			replaced = true;
		} catch (err) {
			this.syncError = errorMessage(err);
		} finally {
			this.syncing = false;
		}

		// Re-read Drive to verify that the replacement is valid and finish the merge.
		if (replaced) await this.syncNow();
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

	/** Decrypt and download the current recovery key without rotating it. */
	async downloadCurrentRecoveryKey(): Promise<boolean> {
		this.busy = true;
		this.error = null;
		try {
			const header = await this.repo.getMeta<VaultHeader>(META_HEADER);
			if (!header) return false;
			const { recoveryKey } = await this.client.call('decryptRecoveryKey', { header });
			downloadText('simple-vault-recovery-key.txt', recoveryKey);
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

	/** Download a complete current-format backup, refusing silent record loss. */
	async exportVault(): Promise<boolean> {
		this.busy = true;
		this.error = null;
		try {
			const bytes = await this.#buildVaultBackup();
			downloadBinary(`simple-vault-v${BACKUP_FORMAT}-backup.svault`, bytes);
			return true;
		} catch (err) {
			this.error = errorMessage(err);
			return false;
		} finally {
			this.busy = false;
		}
	}

	/** List the encrypted historical snapshots owned by this app in Drive. */
	async listDriveBackups(): Promise<DriveFile[] | null> {
		if (this.busy) return null;
		this.busy = true;
		this.error = null;
		try {
			const token = this.#driveToken ?? (await this.#connectDrive());
			return await listBackupFiles(token);
		} catch (err) {
			this.error = errorMessage(err);
			return null;
		} finally {
			this.busy = false;
		}
	}

	/** Upload a validated local snapshot, then permanently prune snapshots older than the newest ten. */
	async createDriveBackup(): Promise<boolean> {
		if (this.busy) return false;
		this.busy = true;
		this.error = null;
		let created = false;
		try {
			const bytes = await this.#buildVaultBackup();
			const token = this.#driveToken ?? (await this.#connectDrive());
			await createBinaryFile(token, backupFileName(), bytes);
			created = true;
			const backups = await listBackupFiles(token);
			for (const backup of backups.slice(DRIVE_BACKUP_LIMIT)) {
				await deleteFile(token, backup.id);
			}
			return true;
		} catch (err) {
			this.error = created
				? `The backup was created, but old backups could not be removed: ${errorMessage(err)}`
				: errorMessage(err);
			return false;
		} finally {
			this.busy = false;
		}
	}

	/** Download and validate a historical Drive snapshot without changing local data. */
	async fetchDriveBackup(fileId: string): Promise<Bytes | null> {
		if (this.busy) return null;
		this.busy = true;
		this.error = null;
		try {
			const token = this.#driveToken ?? (await this.#connectDrive());
			const bytes = await downloadBytes(token, fileId);
			decodeBackup(bytes);
			return bytes;
		} catch (err) {
			this.error = errorMessage(err);
			return null;
		} finally {
			this.busy = false;
		}
	}

	async downloadDriveBackup(file: DriveFile): Promise<boolean> {
		const bytes = await this.fetchDriveBackup(file.id);
		if (!bytes) return false;
		downloadBinary(file.name, bytes);
		return true;
	}

	/** Validate a backup secret and return only safe, non-secret fields for review. */
	async previewVaultBackup(
		bytes: Bytes,
		secret: string,
		method: UnlockMethod
	): Promise<BackupPreview | null> {
		this.busy = true;
		this.error = null;
		try {
			const bundle = decodeBackup(bytes);
			const result = await this.client.call('previewBackup', {
				header: bundle.header,
				secret,
				method,
				folders: bundle.folders.map(decodeFolderFile)
			});
			if (!result.ok || !result.preview) {
				this.error = method === 'password' ? 'Incorrect backup password.' : 'Invalid recovery key.';
				return null;
			}
			return result.preview;
		} catch (err) {
			this.error = errorMessage(err);
			return null;
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Merge a backup's records into the open vault, keeping this device's keys.
	 * The backup is decrypted with its own master password / recovery key, then
	 * re-encrypted under the current DEK. Same-id conflicts keep whichever side
	 * was updated most recently. The header, Drive link and local unlock are all
	 * left in place; changed records are queued for the next Drive sync.
	 */
	async importBackupRecords(
		bytes: Bytes,
		secret: string,
		method: UnlockMethod
	): Promise<boolean> {
		this.busy = true;
		this.error = null;
		try {
			const bundle = decodeBackup(bytes);
			const res = await this.client.call('importBackupRecords', {
				header: bundle.header,
				secret,
				method,
				folders: bundle.folders.map(decodeFolderFile)
			});
			if (!res.ok || !res.folders || !res.records) {
				this.error =
					method === 'password' ? 'Incorrect backup password.' : 'Invalid recovery key.';
				return false;
			}
			await this.repo.putFolders(mergeById(await this.repo.allFolders(), res.folders));
			const local = await this.repo.allRecords();
			const before = new Map(local.map((record) => [record.id, record]));
			const merged = mergeStoredRecords(local, res.records);
			await this.repo.putRecords(merged);
			// Queue only records the backup actually changed for the next Drive sync.
			for (const record of merged) {
				const prev = before.get(record.id);
				if (
					!prev ||
					prev.updated !== record.updated ||
					prev.historyUpdated !== record.historyUpdated
				) {
					await this.#markRecordPending(record.id);
				}
			}
			await this.#ensureFolderRows();
			await this.#decryptCachedFolderNames();
			await this.loadCards();
			this.#scheduleAutoSync();
			return true;
		} catch (err) {
			this.error = errorMessage(err);
			return false;
		} finally {
			this.busy = false;
		}
	}

	/** Validate and replace local data with an imported current-format backup, then re-lock. */
	async importVault(bytes: Bytes): Promise<void> {
		const bundle = decodeBackup(bytes);
		const decoded = bundle.folders.map(decodeFolderFile);
		// A restored file may belong to a different Drive vault. Drop the old
		// connection so the next unlock cannot merge the two automatically.
		this.disconnectDrive();
		await this.repo.clear();
		this.localUnlockKind = null; // the imported vault has a different DEK
		this.#pendingRecordSyncs = {};
		this.lastSync = null;
		this.syncError = null;
		this.selectedFolderId = null;
		this.search = '';
		this.copiedId = null;
		await this.repo.setMeta(META_HEADER, bundle.header);
		for (const item of decoded) {
			await this.repo.putFolders([item.folder]);
			await this.repo.putRecords(item.records);
		}
		await this.lock();
	}

	/** Forget the Drive connection for this session (keeps local data). */
	disconnectDrive(): void {
		this.#cancelAutoSync();
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

	/** Build the one-file backup representation shared by browser and Drive exports. */
	async #buildVaultBackup(): Promise<Bytes> {
		const header = await this.repo.getMeta<VaultHeader>(META_HEADER);
		if (!header) throw new Error('No local vault is available to export.');
		await this.#ensureFolderRows();

		const [storedFolders, records] = await Promise.all([
			this.repo.allFolders(),
			this.repo.allRecords()
		]);
		const folderIds = new Set(storedFolders.map((folder) => folder.id));
		const orphan = records.find((record) => !folderIds.has(record.folderId));
		if (orphan) throw new Error(`Cannot export record ${orphan.id}: its folder is missing.`);

		const encodedFolders: Bytes[] = [];
		let encodedRecordCount = 0;
		for (const folder of storedFolders) {
			const folderRecords = records.filter((record) => record.folderId === folder.id);
			encodedRecordCount += folderRecords.length;
			encodedFolders.push(encodeFolderFile(folder, folderRecords));
		}
		if (encodedRecordCount !== records.length) {
			throw new Error('Backup validation failed: not every record was included.');
		}

		const bytes = encodeBackup(header, encodedFolders);
		const verified = decodeBackup(bytes).folders
			.map(decodeFolderFile)
			.reduce((count, folder) => count + folder.records.length, 0);
		if (verified !== records.length) {
			throw new Error('Backup validation failed: record count changed during encoding.');
		}
		return bytes;
	}

	async #uploadFolder(folderId: string): Promise<void> {
		if (!this.#driveToken) return;
		let folder = await this.repo.getFolder(folderId);
		if (!folder) return;
		if (!folder.enc_name) {
			folder = (await this.client.call('encryptFolders', [folder]))[0];
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

	/** Persist a local record change before exposing it as pending in the UI. */
	async #markRecordPending(id: string): Promise<void> {
		this.#pendingRecordSyncs = { ...this.#pendingRecordSyncs, [id]: Date.now() };
		await this.repo.setMeta(META_PENDING_RECORD_SYNCS, this.#pendingRecordSyncs);
	}

	/** Clear only changes that were present, and unchanged, when the sync began. */
	async #clearSyncedRecords(synced: Record<string, number>): Promise<void> {
		const remaining = { ...this.#pendingRecordSyncs };
		for (const [id, changedAt] of Object.entries(synced)) {
			if (remaining[id] === changedAt) delete remaining[id];
		}
		this.#pendingRecordSyncs = remaining;
		if (Object.keys(remaining).length) {
			await this.repo.setMeta(META_PENDING_RECORD_SYNCS, remaining);
		} else {
			await this.repo.deleteMeta(META_PENDING_RECORD_SYNCS);
		}
	}

	/** Debounce Drive sync until 60 seconds after the most recent record change. */
	#scheduleAutoSync(): void {
		this.#cancelAutoSync();
		if (!browser || this.status !== 'unlocked' || !this.#driveToken) return;
		const changedAt = Object.values(this.#pendingRecordSyncs);
		if (!changedAt.length) return;
		const dueAt = Math.max(...changedAt) + AUTO_SYNC_DEBOUNCE_MS;
		const delay = Math.max(0, dueAt - Date.now());
		this.nextAutoSyncAt = dueAt;
		this.#autoSyncTimer = setTimeout(() => {
			this.#autoSyncTimer = null;
			this.nextAutoSyncAt = null;
			if (this.syncing) {
				this.nextAutoSyncAt = Date.now() + 1_000;
				this.#autoSyncTimer = setTimeout(() => {
					this.#autoSyncTimer = null;
					this.nextAutoSyncAt = null;
					this.#scheduleAutoSync();
				}, 1_000);
				return;
			}
			void this.syncNow();
		}, delay);
	}

	#cancelAutoSync(): void {
		if (this.#autoSyncTimer !== null) clearTimeout(this.#autoSyncTimer);
		this.#autoSyncTimer = null;
		this.nextAutoSyncAt = null;
	}

	/** Ensure the root and every record-owning folder have an encrypted row. */
	async #ensureFolderRows(): Promise<void> {
		const [records, folders] = await Promise.all([
			this.repo.allRecords(),
			this.repo.allFolders()
		]);
		const requiredIds = new Set([ROOT_FOLDER_ID, ...records.map((record) => record.folderId)]);
		const existingIds = new Set(folders.map((folder) => folder.id));
		const missingIds = [...requiredIds].filter((id) => !existingIds.has(id));
		if (!missingIds.length) return;

		const now = updatedNow();
		const repaired = await this.client.call(
			'encryptFolders',
			missingIds.map((id) => ({
				id,
				name: id === ROOT_FOLDER_ID ? '' : `Recovered folder (${id})`,
				updated: now,
				status: 'active' as const
			}))
		);
		await this.repo.putFolders(repaired);
	}

	async #decryptCachedFolderNames(): Promise<void> {
		const encrypted = (await this.repo.allFolders()).filter((folder) => folder.enc_name);
		if (!encrypted.length) return;
		await this.repo.putFolders(await this.client.call('decryptFolders', encrypted));
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
	 * when the cached token is missing or expired. This does not force a sync,
	 * but it resumes the debounce timer when local record changes are pending.
	 */
	async #trySilentConnect(): Promise<void> {
		const cached = this.#loadCachedToken();
		if (cached) {
			this.#driveToken = cached;
			this.driveConnected = true;
			this.#scheduleAutoSync();
			return;
		}
		try {
			await this.#connectDrive('none');
			this.#scheduleAutoSync();
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
