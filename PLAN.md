# Simple Vault v2 plan

This document describes the intentionally incompatible pre-alpha v2 storage
format. There is no migration path from the old single `vault.json` ciphertext.
Old local databases and old Drive files may be discarded.

## 1. Goals

- Keep all cryptography in the browser and keep Google Drive as an opaque store.
- Store one small vault header plus one data file per logical folder.
- Encrypt records independently so editing one record never re-encrypts unrelated
  records.
- Keep password history in its own ciphertext and decrypt it only when requested.
- Keep card metadata available independently from secrets in application memory.
- Use compact positional data and a binary Drive format; never Base64-encode folder
  payloads.
- Use `updated`, not `version`, for conflict comparison. `updated` is Unix time in
  whole seconds.
- Accept breaking changes while the project is pre-alpha.

## 2. Identifiers and timestamps

### 2.1 Record and folder IDs

New IDs use the last eight Base32 characters of the current millisecond timestamp:

```ts
Date.now().toString(32).slice(-8)
```

The binary format decodes the eight Base32 digits into an unsigned 40-bit value
and stores it in five bytes. The application-facing representation remains the
eight-character Base32 string.

### 2.2 `updated`

Every independently mergeable value has an `updated` timestamp:

```ts
Math.floor(Date.now() / 1000)
```

JSON/debug output may render it with `updated.toString(32)`. Binary files store it
as an unsigned 32-bit integer. The design deliberately treats one second as the
smallest observable update interval.

## 3. Cryptographic hierarchy

- A random 256-bit AES-GCM Data Encryption Key (DEK) encrypts folder metadata,
  record data, and record history.
- The master password is processed by Argon2id to derive a password KEK.
- The recovery key is processed by Argon2id to derive a recovery KEK.
- The header stores the DEK wrapped once by each KEK.
- The header also stores the recovery key encrypted by the DEK as a convenience
  copy; it is not usable until the DEK has already been unlocked.
- Each encrypted component receives a fresh random 12-byte AES-GCM IV and a
  16-byte authentication tag.
- IDs, `updated`, component kind, and folder identity are supplied as AES-GCM
  additional authenticated data (AAD), so ciphertext cannot be moved between
  records or component kinds without authentication failure.

Argon2id runs only during vault unlock or key-management operations. It never runs
per record.

## 4. Google Drive layout

All files live in Drive's hidden `appDataFolder`.

### 4.1 Header file

File name: `simple-vault.header.json`

The header is small and remains JSON:

```ts
interface VaultHeader {
  format: 2;
  kdf: KdfParams;
  saltPassword: string;
  saltRecovery: string;
  wrappedDEK_password: EncBlob;
  wrappedDEK_recovery: EncBlob;
  enc_recoveryKey: EncBlob;
  updated: number; // Unix seconds
}
```

The header contains no records, folders, or monolithic vault ciphertext. It changes
only for key-management operations such as master-password change or recovery-key
regeneration.

### 4.2 Folder files

File name: `simple-vault.folder.<folderId>.svf`

The reserved folder ID `00000000` contains records that the UI calls “No folder”.
Every other logical folder has exactly one Drive file. Folder names and deletion
state are encrypted inside their own file; Drive sees only an opaque folder ID,
file size, and modification metadata.

Drive content updates still replace the complete affected folder file. Unchanged
record ciphertext bytes are copied unchanged: only edited components are encrypted.

## 5. Plain record model

Field names are not persisted inside encrypted record payloads. Positional values
are CBOR-encoded before AES-GCM encryption. The stable formats are:

```ts
type RecordData = [
  title: string,
  username: string,
  password: string,
  siteUrl: string,
  notes: string
];

type HistoryData = Array<[
  password: string,
  updated: number
]>;
```

Existing positions never change meaning. Future optional fields are appended. A
folder-file format revision or per-component codec revision supplies defaults for
missing trailing positions.

History is absent until the first password change. Non-password edits copy the
history ciphertext without decrypting it. A password change decrypts that record's
history, appends the previous password, and re-encrypts only the history component.

## 6. CBOR folder format

Folder files use `cbor-x` with record extensions, shared structures, structured
cloning, and typed-array tags disabled. The schema uses only positional CBOR arrays,
unsigned integers, and ordinary CBOR byte strings, so every file is self-contained.

```ts
type FolderFile = [
  format: 2,
  folderId: ByteString,          // five-byte Base32 ID
  folderUpdated: number,
  folderFlags: number,           // bit 0 = deleted
  encryptedFolderName: ByteString,
  records: Array<[
    id: ByteString,              // five bytes
    updated: number,
    flags: number,               // bit 0 = deleted
    encryptedData: ByteString
  ]>,
  histories: Array<[
    id: ByteString,
    updated: number,
    encryptedHistory: ByteString
  ]>
];
```

An encrypted blob is packed without Base64:

```text
12-byte IV || AES-GCM ciphertext || 16-byte authentication tag
```

The decoder validates the outer and nested tuple lengths, format, byte-string types,
five-byte IDs, unsigned timestamp range, flags, encrypted blob minimum sizes,
duplicate IDs, orphan histories, malformed CBOR, and trailing bytes.

## 7. Local IndexedDB model

IndexedDB remains optimized for UI and merge operations rather than mirroring the
wire bytes exactly:

```ts
interface StoredRecord {
  id: string;
  folderId: string;
  updated: number;
  status: 'active' | 'deleted';
  enc_data: EncBlob;
  enc_history?: EncBlob;
}
```

`folderId`, `updated`, and status are intentionally plaintext locally so Dexie can
index and merge without decrypting every record. They are not repeated inside the
encrypted `RecordData` tuple. Folder membership is derived from the containing file
on Drive.

Card loading decrypts `enc_data` inside the key worker and returns only title and
username. Password, URL, and notes are returned only for an explicit record action.
History has a separate worker operation and is decrypted only when the history UI
is opened or when a password change needs to append an item.

## 8. Sync

### 8.1 Discovery

1. Locate and download `simple-vault.header.json`.
2. Unlock the DEK with the master password, recovery key, or device-local unlocker.
3. List `simple-vault.folder.*.svf` files in `appDataFolder`.
4. Download changed folder files, decode them, and merge by `(id, updated)`.

Drive's server-side file version may be cached only as a download optimization. It
is not part of the domain model and is never called the record version.

### 8.2 Merge

- Higher `updated` wins.
- Equal `updated` is treated as the same logical revision under the deliberate
  one-second resolution rule.
- Record deletion is a tombstone and participates in the same comparison.
- A record tombstone makes any history with the same ID unreachable.
- Folder deletion remains as an encrypted tombstone file so an offline device does
  not recreate it.

### 8.3 Push

- Creating or editing a record rebuilds and uploads only its containing folder file.
- Moving a record rebuilds both the source and destination folder files.
- Adding, renaming, or deleting a folder rebuilds only that folder file.
- The header is not uploaded for ordinary record or folder edits.
- Sync serializes ciphertext already stored in IndexedDB; it does not decrypt and
  re-encrypt unchanged records.

## 9. Backup and import

The old JSON-envelope export is removed. A v2 backup is a CBOR `.svault` bundle:

```ts
[format: 2, header: VaultHeader, folderFiles: ByteString[]]
```

Import is all-or-nothing, validates the complete bundle first, then replaces local
data and re-locks. The recovery key remains a separate download and is never
included in plaintext.

## 10. Key-management consequences

- Recovery-key regeneration rewraps the current DEK and updates only the header.
- A master-password change retains the current product policy of rotating the DEK.
  Consequently it must decrypt and re-encrypt every active encrypted component once,
  rewrite all local rows, upload every folder file, and update the header.
- Device-local biometric/PIN wrappers are deleted after DEK rotation and must be
  enrolled again.

## 11. Implementation order

1. Add ID/time helpers, tuple codecs, packed encrypted blobs, CBOR folder codec,
   and unit tests.
2. Split history from record data in the worker protocol and IndexedDB schema.
3. Replace `VaultEnvelope` with the ciphertext-free `VaultHeader`.
4. Replace the Drive client with header/folder listing and binary upload APIs.
5. Replace monolithic hydrate/persist/sync with per-folder merge and upload.
6. Replace JSON backup/import with the v2 binary bundle.
7. Update unit and end-to-end tests, then remove all v1 code.

## 12. Explicitly accepted constraints

- IDs are timestamp-derived and can collide if two IDs are generated in the same
  millisecond.
- `updated` cannot distinguish two meaningful updates to the same component within
  one second.
- Drive uploads replace the complete affected folder file; Drive cannot patch one
  binary record in place.
- Folder-file separation exposes the number and approximate sizes of folders, while
  folder names and all record contents remain encrypted.
