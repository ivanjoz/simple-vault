// A device-local unlocker: material that lets this device re-derive the DEK
// without the master password. It wraps the DEK under a key gated by either a
// platform authenticator (WebAuthn PRF — fingerprint/face/device-PIN) or a
// user PIN/pattern (Argon2id-stretched). Stored ONLY in this device's IndexedDB
// (never synced to Drive), so each device enrols independently.

import type { EncBlob, KdfParams } from '$lib/crypto';

export interface WebAuthnUnlocker {
	kind: 'webauthn';
	/** base64url of the credential rawId, used in allowCredentials on unlock. */
	credentialId: string;
	/** base64 salt fed to the PRF extension (stable → stable derived key). */
	prfSalt: string;
	/** DEK wrapped by the PRF-derived AES-GCM key. */
	wrappedDek: EncBlob;
}

export interface PinUnlocker {
	kind: 'pin';
	kdf: KdfParams;
	/** base64 Argon2id salt. */
	salt: string;
	/** DEK wrapped by the PIN-derived AES-GCM key. */
	wrappedDek: EncBlob;
	/** Consecutive failed attempts (throttling / lockout). */
	attempts: number;
}

export type LocalUnlocker = WebAuthnUnlocker | PinUnlocker;
export type LocalUnlockKind = LocalUnlocker['kind'];
