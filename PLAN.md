# Simple Vault — Implementation Plan

A fully client-side ("backendless") password manager. All cryptography happens in
the browser. Google Drive is used only as a dumb store for a single encrypted
envelope file. Dexie/IndexedDB is the local cache for offline use and fast
rendering. **No server ever sees plaintext, keys, or the master password.**

The UX takes inspiration from Bitwarden but is deliberately simpler.

---

## 1. Goals & Non-Goals

### Goals
- Backendless: no application server; only static hosting.
- End-to-end encryption in the browser using the WebCrypto API.
- Google Drive as encrypted-blob storage (per-user, in a hidden app folder).
- Local-first: fully usable offline via IndexedDB; Drive is the backup/sync target.
- Dual unlock: master password **or** a downloadable recovery key.
- Simple entry schema: folder, title, username, password, notes + password history.
- Responsive card-based UI with one-click password copy.
- Strict memory hygiene for secrets.

### Non-Goals (initial version)
- No multi-device real-time collaboration (sync is last-write-wins per record).
- No sharing/organizations.
- No browser-extension autofill.
- No mobile native app (responsive web only).

---

## 2. Tech Stack

| Concern            | Choice                                                        |
|--------------------|---------------------------------------------------------------|
| Framework          | SvelteKit 2 + Svelte 5 (runes)                                |
| Runtime / PM       | Bun 1.3.x                                                      |
| Styling            | Tailwind CSS                                                  |
| Language           | TypeScript (TS 7 native `tsgo` preview for CLI typecheck)     |
| Adapter            | `@sveltejs/adapter-static` (pure SPA, no backend)             |
| Local DB           | Dexie (IndexedDB)                                             |
| KDF                | Argon2id via `hash-wasm`                                      |
| Symmetric crypto   | WebCrypto `SubtleCrypto` — AES-GCM-256                        |
| Cloud storage      | Google Drive API v3, scope `drive.appdata`                    |
| Auth               | Google Identity Services (GIS) token client, OAuth2 + PKCE    |
| Key holding        | Dedicated Web Worker (in-memory, non-extractable `CryptoKey`) |
| Tests              | `bun test`                                                    |

### Prerequisite (user-provided, later)
A Google Cloud **OAuth Client ID** (Web application) with the Drive API enabled.
Development proceeds with a placeholder env var `PUBLIC_GOOGLE_CLIENT_ID`; console
setup steps will be documented.

---

## 3. Cryptographic Design (Envelope Encryption)

Rather than storing two full ciphertext copies, the vault uses **envelope
encryption**: the bulk data is encrypted once with a random Data Encryption Key
(DEK), and the DEK itself is wrapped (encrypted) multiple times so it can be
unlocked by different secrets.

### 3.1 Keys
- **DEK** — random 256-bit AES-GCM key. Encrypts all vault records. Imported as a
  **non-extractable** `CryptoKey` for the session.
- **Master password** — user-chosen. Never stored. Feeds Argon2id → **master-KEK**.
- **Recovery key** — random high-entropy string generated at vault creation, shown
  once and downloaded by the user. Feeds a KDF → **recovery-KEK**.

### 3.2 Argon2id parameters (tunable)
- memory: 64 MiB, iterations: 3, parallelism: 1, output: 32 bytes.
- Unique random salt per KEK, stored in the envelope.

### 3.3 The Drive envelope (single JSON file in `appDataFolder`)
```jsonc
{
  "version": 1,
  "kdf": { "algo": "argon2id", "mem": 65536, "iters": 3, "parallelism": 1 },
  "saltPassword": "<base64>",      // salt for master-KEK
  "saltRecovery": "<base64>",      // salt for recovery-KEK
  "iv": "<base64>",                // IV for the records ciphertext
  "ciphertext": "<base64>",        // AES-GCM(DEK) of the full records array
  "wrappedDEK_password": "<base64+iv>",  // DEK wrapped by master-KEK
  "wrappedDEK_recovery": "<base64+iv>",  // DEK wrapped by recovery-KEK
  "enc_recoveryKey": "<base64+iv>",      // recovery key, AES-GCM(DEK) — convenience copy
  "updated": 0                     // envelope-level timestamp for coarse conflict detection
}
```

### 3.4 Why `enc_recoveryKey` is stored (and why it's safe)
It is a **convenience copy**, not the recovery mechanism. It is encrypted with the
DEK, so it is only readable by someone who can already unlock the vault (via master
password or recovery key) — i.e. someone who already has full access. It therefore
adds no meaningful attack surface. Its sole purpose: let the app **re-wrap keys
during a master-password change** without prompting the user to paste or re-download
their recovery key.

The real recovery flow is unchanged: if the master password is forgotten, the user
unlocks with their **separately downloaded** recovery key; `enc_recoveryKey` is
irrelevant in that flow.

### 3.5 Unlock flow
1. User enters master password (or recovery key).
2. Derive the corresponding KEK (Argon2id + stored salt).
3. Unwrap the matching `wrappedDEK_*` → DEK (imported non-extractable into the Worker).
4. Discard the typed password immediately.
5. Decrypt records; populate IndexedDB (delta) and the in-memory display store.

### 3.6 Master-password change → full re-encrypt + re-upload (DEK rotation)
1. Session is unlocked → decrypt `enc_recoveryKey` with the current DEK.
2. Generate a **new DEK**; re-encrypt **every** record (`enc_meta` + `enc_secret`).
3. Derive a new master-KEK from the new password (fresh salt).
4. Wrap the new DEK with (a) the new master-KEK and (b) the existing recovery key.
5. Re-encrypt `enc_recoveryKey` under the new DEK.
6. Rebuild the envelope, **re-upload the whole file to Drive**, refresh IndexedDB,
   swap the in-memory DEK.
→ No re-download, no paste prompt; the downloaded recovery key keeps working.

### 3.7 Regenerate recovery key (explicit user action)
Generates a fresh recovery key, re-wraps the current DEK with the new recovery-KEK,
re-encrypts `enc_recoveryKey`, re-uploads, and prompts download. The old recovery
key stops working.

### 3.8 Recovery-key format
- Random base32 (Crockford, no ambiguous chars) grouped as **4 groups of 4**
  digits, e.g. `A3F9-K72M-BQ8X-P4WD` (128 bits of entropy).
- Case-insensitive on input; hyphens and whitespace stripped before use.
- Delivered as a downloadable `.txt` file at generation time (shown once).

---

## 4. Data Model

### 4.1 Record (as stored in IndexedDB and inside the Drive ciphertext array)
```ts
interface VaultRecord {
  id: string;            // uuid
  folderId: string;      // plaintext — sidebar filtering / indexing
  updated: number;       // unix ms — plaintext, drives delta sync
  status: 'active' | 'deleted';  // tombstone via status (delete propagation)
  enc_meta: EncBlob;     // AES-GCM(DEK): { title, username }
  enc_secret: EncBlob;   // AES-GCM(DEK): { password, notes, history }
}

interface MetaPlain   { title: string; username: string; }
interface SecretPlain { password: string; notes: string; history: HistoryItem[]; }
interface HistoryItem { p: string; u: number; }  // p = old password, u = unix ms
type EncBlob = { iv: string; data: string };     // both base64
```

- `updated` and `status` are **plaintext** so delta sync and filtering never require
  decryption.
- `folderId` is plaintext (a non-sensitive reference).
- Titles/usernames live in `enc_meta`; passwords/notes/history live in `enc_secret`.

### 4.2 Password history
Whenever the `password` field changes, the previous value is pushed onto
`history` as `{ p, u }` (old password + unix-ms timestamp). Minimal footprint,
encrypted inside `enc_secret`, decrypted only on demand (subject to the 40 s TTL).

### 4.3 Folder
```ts
interface Folder { id: string; name: string; updated: number; status: 'active' | 'deleted'; }
```

### 4.4 Dexie schema
```ts
db.version(1).stores({
  records: 'id, folderId, updated, status',
  folders: 'id, updated, status',
  meta:    'key'   // e.g. envelope metadata, last sync time, Drive fileId
});
```
No key material, no plaintext secrets, and no master password are ever written to
IndexedDB (or localStorage/sessionStorage).

---

## 5. Memory & Session Model

### 5.1 Two distinct secret classes
- **DEK (master key):** derived once at unlock, held inside a **SharedWorker**
  (falls back to a dedicated Worker). It stays in worker memory (never in reachable
  main-thread state). The SharedWorker is shared across same-origin tabs and dies
  when the last tab closes.
- **Entry password (per-record secret):** encrypted at rest and in memory. Decrypted
  **only** on demand (copy click or detail view). Held **≤ 40 seconds**, then the
  plaintext reference is dropped and the clipboard is cleared.

### 5.2 Session lifetime & staying unlocked across reloads
- Always-on while the tab is open; never expires by timer.
- **Reload persistence:** a dedicated Worker is destroyed on reload, and a
  SharedWorker only *sometimes* survives a sole-tab reload (not guaranteed). So the
  reliable mechanism is an **opt-in `sessionStorage` copy of the DEK** (default on,
  toggle in settings). It survives reloads and is cleared when the tab closes or on
  lock. Tradeoff: while enabled, the DEK is readable by same-origin script (XSS)
  — acceptable given that XSS during an unlocked session can already ask the worker
  to decrypt anything.
- **Idle auto-lock:** off by default, optional toggle (planned).
- Closing all tabs (SharedWorker dies) + no sessionStorage copy → re-unlock with the
  master password or recovery key.

### 5.3 40-second secret TTL
- A single utility governs any decrypted entry password: start a 40 s timer on
  reveal/copy; on expiry drop the reference and clear the clipboard.
- Card list never holds decrypted passwords; only `enc_meta` (title/username) is
  decrypted for display.

### 5.4 Honest limitations (documented in-app)
1. **Best-effort wiping.** JS strings are immutable and GC-controlled; exact scrub
   timing isn't guaranteed. Mitigations: `Uint8Array` for key material with
   `.fill(0)`, keep the DEK off the main thread, never bind entry passwords to
   reactive/DOM state, drop references on the 40 s timer.
2. **Delayed clipboard clear** may be blocked if the tab isn't focused at 40 s —
   best-effort.
3. **Reload persistence** requires the opt-in `sessionStorage` DEK copy (§5.2);
   without it, a reload requires re-unlock. Closing all tabs always requires
   re-unlock (by design).

---

## 6. Synchronization (Delta)

Drive holds one envelope file (whole vault, single ciphertext). IndexedDB holds the
same records individually encrypted for fast local access.

### 6.1 Pull (Drive → IndexedDB)
1. Download envelope; unwrap DEK (already in memory during a session).
2. Decrypt `ciphertext` → full records array (each with `updated`, `status`).
3. For each record, compare `updated` against the local IndexedDB row:
   - new or `drive.updated > local.updated` → **upsert** (write the record).
   - unchanged → **skip** (no re-encrypt, no re-write).
   - `status:'deleted'` → apply tombstone locally.
4. Records are stored **individually encrypted** in IndexedDB.

### 6.2 Push (IndexedDB → Drive)
1. Gather all active + tombstoned records; serialize; encrypt with DEK.
2. Rebuild the envelope (keep the wrapped-DEK blobs unless keys rotated).
3. Upload (overwrite) the single Drive file.

### 6.3 Conflict resolution
- **Per-record, last-write-wins** by `updated` (finer than whole-file LWW).
- Deletes propagate via `status:'deleted'` tombstones.
- Envelope-level `updated` used for a coarse "remote changed since last pull" check
  before merging.

### 6.4 Sync triggers
- On unlock (initial pull), on mutation (debounced push), and a manual "Sync now".
- Offline edits queue locally; push on reconnect.

---

## 7. Google Drive Integration

- **Auth:** Google Identity Services token client, OAuth2 + PKCE, in-browser.
- **Scope:** `https://www.googleapis.com/auth/drive.appdata` — a hidden per-app
  folder invisible in the user's normal Drive listing.
- **Files:** one envelope file (e.g. `vault.json`) in `appDataFolder`; store its
  `fileId` in Dexie `meta`.
- **Tokens:** short-lived access token kept in memory only (no refresh token — a
  backendless app can't safely hold one). After the first consent, the app requests
  new tokens **silently** (`prompt: 'none'`) on load, so there's no popup on every
  visit; it auto-syncs when a silent token is granted.
- **Consent (Testing mode):** while the OAuth app is in "Testing", each Google
  account must be added as a **Test user** or sign-in is blocked (403 access_denied).
- **Config:** `PUBLIC_GOOGLE_CLIENT_ID` env var. Authorized JavaScript origins must
  include the dev/preview/prod origins; **no redirect URI needed** (token/popup flow).

---

## 8. UI / UX

### 8.1 Layout
- **Left side panel:** folder list + menu info (sync status, lock button, settings,
  account).
- **Main area:** a **search filter input** across the top, then a **responsive card
  grid** — **3 columns desktop / 2 tablet / 1 mobile**.

### 8.2 Card
- Title, subtitle (username), masked password (`••••••••`), and a **copy icon**.
- **One-click copy:** decrypts the password on the fly, copies to clipboard, starts
  the 40 s purge + clipboard-clear timer. Brief "copied" feedback.

### 8.3 Detail / edit
- Fields: folder, title, username, password (with reveal, subject to 40 s TTL),
  notes, and a read-only password **history** view.
- **Password generator** (length + character-class options).

### 8.4 Onboarding & unlock screens
- **Onboarding:** create vault → set master password → generate + **download
  recovery key** (shown once).
- **Unlock:** master password, with a "use recovery key" alternative.

### 8.5 Settings
- Connect / disconnect Google Drive, "Sync now".
- Change master password (§3.6), regenerate recovery key (§3.7).
- Export / import (encrypted).
- Optional idle auto-lock toggle.

---

## 9. Project Structure (proposed)
```
src/
  lib/
    crypto/         # KDF, DEK gen, wrap/unwrap, AES-GCM, recovery key
    worker/         # key-holding Web Worker + message protocol
    db/             # Dexie schema + record repository (per-record encryption)
    sync/           # delta pull/push, conflict resolution
    drive/          # GIS auth + Drive API client
    stores/         # Svelte stores (in-memory display state, session)
    ui/             # reusable components (Card, Sidebar, SearchBar, ...)
  routes/
    +layout.svelte
    +page.svelte            # vault (cards)
    onboarding/+page.svelte
    unlock/+page.svelte
    settings/+page.svelte
static/
tests/
```

---

## 10. Build Phases

1. **Scaffold** — SvelteKit 2 + Svelte 5 + Bun + Tailwind + TS, `adapter-static`,
   `.env` with placeholder `PUBLIC_GOOGLE_CLIENT_ID`, base layout & routing.
2. **Crypto core** (`lib/crypto`) — Argon2id KDF, DEK gen, wrap/unwrap ×2, AES-GCM
   field encrypt/decrypt, recovery-key generation & formatting. `bun test`.
3. **Key/session Worker** — in-memory non-extractable DEK, message protocol,
   unlock/lock, 40 s secret-TTL utility, clipboard auto-clear.
4. **Dexie layer** — schema, per-record encrypt, `updated` maintenance, delta
   upsert, tombstones.
5. **Onboarding & unlock** — create vault → master password → download recovery
   key; unlock via password *or* recovery key.
6. **Vault UI** — side panel, search, responsive card grid, one-click copy,
   detail/edit form, password generator, history view.
7. **Drive sync** — GIS OAuth + PKCE, `appDataFolder`, delta pull / merged push,
   sync-status indicator.
8. **Settings & hardening** — change master password (DEK rotation, §3.6),
   regenerate recovery key, export/import, optional idle-lock, disconnect Drive.

Each phase produces a working, verifiable increment. After phase 5 a local vault can
be created and unlocked; after phase 7 it syncs to Drive; phase 8 rounds out account
management.

---

## 11. Open Items / Future
- Encrypted export/import format details.
- Google verification/consent-screen review for production use of the Drive scope.
- Optional: WebAuthn/passkey as an additional unlock factor.
