// Shared crypto types.

/**
 * ArrayBuffer-backed byte array. TS 7's stricter typed-array generics require an
 * explicit `ArrayBuffer` (not `SharedArrayBuffer`) backing for WebCrypto's
 * `BufferSource`, so all crypto helpers traffic in this type.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** An AES-GCM ciphertext together with its IV. Both fields are base64. */
export interface EncBlob {
	iv: string;
	data: string;
}

/** Argon2id parameters, stored in the envelope so a vault can always be reopened. */
export interface KdfParams {
	algo: 'argon2id';
	/** Memory cost in KiB. */
	mem: number;
	/** Iteration (time) cost. */
	iters: number;
	parallelism: number;
	/** Derived key length in bytes. */
	hashLength: number;
}

/**
 * The single encrypted file stored in Google Drive (and mirrored conceptually
 * in IndexedDB). See PLAN.md §3.3.
 */
export interface VaultEnvelope {
	version: number;
	kdf: KdfParams;
	/** base64 salt for the master-password KEK. */
	saltPassword: string;
	/** base64 salt for the recovery-key KEK. */
	saltRecovery: string;
	/** All vault records (JSON array) encrypted with the DEK. */
	ciphertext: EncBlob;
	/** DEK wrapped by the master-password KEK. */
	wrappedDEK_password: EncBlob;
	/** DEK wrapped by the recovery-key KEK. */
	wrappedDEK_recovery: EncBlob;
	/** The recovery key itself, encrypted with the DEK (convenience copy, PLAN.md §3.4). */
	enc_recoveryKey: EncBlob;
	/** Envelope-level timestamp (unix ms) for coarse conflict detection. */
	updated: number;
}
