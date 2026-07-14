// Public surface of the crypto core.
export type { Bytes, EncBlob, KdfParams, VaultHeader } from './types.ts';
export type { CreatedVault, CreateVaultOptions, UnlockMethod } from './envelope.ts';

export { utf8ToBytes, bytesToUtf8, bytesToBase64, base64ToBytes } from './encoding.ts';
export { randomBytes, generateRecoveryKey, normalizeRecoveryKey, RECOVERY_KEY_GROUPS } from './random.ts';
export { aesEncrypt, aesDecrypt, importAesKey } from './aes.ts';
export { DEFAULT_KDF, deriveKek, deriveKekBytes } from './kdf.ts';
export { generateDekBytes, importDek, wrapDek, unwrapDek } from './dek.ts';
export {
	createVault,
	unlockDekBytes,
	unlockWithPassword,
	unlockWithRecovery,
	decryptRecoveryKey,
	encryptJson,
	decryptJson
} from './envelope.ts';
