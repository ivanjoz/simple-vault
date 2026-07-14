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
 * The small key header stored separately from folder payload files.
 */
export interface VaultHeader {
	format: 2;
	kdf: KdfParams;
	/** base64 salt for the master-password KEK. */
	saltPassword: string;
	/** base64 salt for the recovery-key KEK. */
	saltRecovery: string;
	/** DEK wrapped by the master-password KEK. */
	wrappedDEK_password: EncBlob;
	/** DEK wrapped by the recovery-key KEK. */
	wrappedDEK_recovery: EncBlob;
	/** The recovery key itself, encrypted with the DEK (convenience copy, PLAN.md §3.4). */
	enc_recoveryKey: EncBlob;
	/** Header timestamp in whole Unix seconds. */
	updated: number;
}
