/**
 * Drive/blob generation. Any breaking change to a Drive file must bump this
 * value so the new writer cannot discover or overwrite files from that layout.
 */
export const DRIVE_STORAGE_VERSION = 3 as const;
export const DRIVE_FILE_NAMESPACE = `simple-vault.v${DRIVE_STORAGE_VERSION}`;

/** Independent schemas that did not change with the Drive blob generation. */
export const HEADER_FORMAT = 2 as const;
export const ENCRYPTED_COMPONENT_FORMAT = 2 as const;
export const VAULT_DB_NAME = 'simple-vault-v2';
export const VAULT_AAD_NAMESPACE = `sv${ENCRYPTED_COMPONENT_FORMAT}`;

/** Binary containers changed with the Drive blob layout. */
export const FOLDER_FILE_FORMAT = DRIVE_STORAGE_VERSION;
export const BACKUP_FORMAT = DRIVE_STORAGE_VERSION;
