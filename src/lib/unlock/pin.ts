// PIN / pattern unlock. A PIN is low-entropy, so it is NOT as strong as the
// master password: anyone who copies this device's IndexedDB can grind the PIN
// offline, bounded only by Argon2id's per-guess cost. We stretch it with the same
// Argon2id parameters as the master password and rely on UI-level attempt
// throttling (see vault.svelte.ts) for casual protection. This path exists as a
// fallback for devices without a platform authenticator.

import { DEFAULT_KDF, deriveKek, randomBytes } from '$lib/crypto';
import type { Bytes, KdfParams } from '$lib/crypto';

const PIN_SALT_BYTES = 16;

export interface PinSetup {
	salt: Bytes;
	kdf: KdfParams;
	/** AES-GCM key derived from the PIN — used to wrap the DEK. */
	key: CryptoKey;
}

/** Derive a wrapping key for a brand-new PIN (fresh random salt). */
export async function enrollPinKey(pin: string): Promise<PinSetup> {
	const salt = randomBytes(PIN_SALT_BYTES);
	const kdf = DEFAULT_KDF;
	return { salt, kdf, key: await deriveKek(pin, salt, kdf) };
}

/** Re-derive the wrapping key for an existing PIN unlocker. */
export async function derivePinKey(pin: string, salt: Bytes, kdf: KdfParams): Promise<CryptoKey> {
	return deriveKek(pin, salt, kdf);
}
