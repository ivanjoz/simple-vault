// WebAuthn platform-authenticator unlock via the PRF extension.
//
// The platform authenticator (fingerprint / face / device PIN) holds a secret in
// its secure element. The PRF extension lets us evaluate a stable 32-byte output
// for a fixed salt *only after a successful user verification*; that output never
// leaves the device in extractable form and cannot be recomputed offline from the
// stored blob. We import it as an AES-GCM key and use it to wrap the vault DEK.
//
// There is no server here, so the WebAuthn `challenge` is not verified by anyone —
// it exists only to satisfy the API; all security comes from the authenticator
// gating the PRF evaluation behind user verification.

import { base64ToBytes, bytesToBase64, importAesKey, randomBytes } from '$lib/crypto';
import type { Bytes } from '$lib/crypto';

// The PRF extension isn't present in every lib.dom version, so we keep local,
// minimal typings and cast at the WebAuthn call sites.
interface PrfOutputs {
	enabled?: boolean;
	results?: { first?: ArrayBuffer };
}

function b64urlFromBuffer(buf: ArrayBuffer): string {
	return bytesToBase64(new Uint8Array(buf))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function bufferFromB64url(s: string): Bytes {
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
	return base64ToBytes(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
}

/** True if this device exposes a user-verifying platform authenticator. */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
	if (typeof PublicKeyCredential === 'undefined') return false;
	try {
		return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
	} catch {
		return false;
	}
}

export interface WebAuthnEnrollment {
	credentialId: string;
	prfSalt: string;
	/** AES-GCM key derived from the PRF output — used to wrap the DEK. */
	key: CryptoKey;
}

/**
 * Register a platform credential and return the PRF-derived wrapping key.
 * Returns null if the authenticator doesn't support the PRF extension (in which
 * case the caller should fall back to a PIN).
 */
export async function enrollWebAuthn(): Promise<WebAuthnEnrollment | null> {
	const prfSalt = randomBytes(32);
	const cred = (await navigator.credentials.create({
		publicKey: {
			rp: { name: 'Simple Vault' }, // id defaults to the current origin's domain
			user: { id: randomBytes(16), name: 'simple-vault', displayName: 'Simple Vault' },
			challenge: randomBytes(32),
			pubKeyCredParams: [
				{ type: 'public-key', alg: -7 }, // ES256
				{ type: 'public-key', alg: -257 } // RS256
			],
			authenticatorSelection: {
				authenticatorAttachment: 'platform',
				userVerification: 'required',
				residentKey: 'preferred'
			},
			timeout: 60_000,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			extensions: { prf: { eval: { first: prfSalt } } } as any
		}
	})) as PublicKeyCredential | null;
	if (!cred) return null;

	const ext = cred.getClientExtensionResults() as { prf?: PrfOutputs };
	if (!ext.prf?.enabled) return null; // authenticator lacks PRF support

	const credentialId = b64urlFromBuffer(cred.rawId);
	// Some platforms return the PRF result on create(); others require an assertion.
	let output = ext.prf.results?.first;
	if (!output) output = await evaluatePrf(credentialId, prfSalt);

	return {
		credentialId,
		prfSalt: bytesToBase64(prfSalt),
		key: await importAesKey(new Uint8Array(output))
	};
}

/** Assert against a known credential and return the PRF-derived wrapping key. */
export async function unlockWebAuthn(credentialId: string, prfSaltB64: string): Promise<CryptoKey> {
	const output = await evaluatePrf(credentialId, base64ToBytes(prfSaltB64));
	return importAesKey(new Uint8Array(output));
}

async function evaluatePrf(credentialId: string, prfSalt: Uint8Array): Promise<ArrayBuffer> {
	const assertion = (await navigator.credentials.get({
		publicKey: {
			challenge: randomBytes(32),
			allowCredentials: [{ type: 'public-key', id: bufferFromB64url(credentialId) }],
			userVerification: 'required',
			timeout: 60_000,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			extensions: { prf: { eval: { first: prfSalt } } } as any
		}
	})) as PublicKeyCredential | null;
	if (!assertion) throw new Error('Authentication was cancelled.');
	const ext = assertion.getClientExtensionResults() as { prf?: PrfOutputs };
	const output = ext.prf?.results?.first;
	if (!output) throw new Error('This device did not return a biometric key (PRF unavailable).');
	return output;
}
