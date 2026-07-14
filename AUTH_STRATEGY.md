# Auth & App-Lock Strategy

Rationale for how Simple Vault unlocks on a device — especially the mobile PWA —
and why it's built the way it is. Companion to `PLAN.md` (which covers the core
envelope/KDF crypto). This document covers only the **unlock layer** added on top.

## 1. The problem

Two things drove this design:

1. **We want a fast unlock on mobile** — typing a long master password every time
   is painful. Users expect "open with fingerprint / face / the phone's PIN or
   pattern," the way native apps behave.
2. **The PWA doesn't re-lock when closed.** A `SharedWorker` holds the unlocked
   DEK in memory (see `src/lib/worker/keyClient.ts`), so backgrounding or
   reopening the app finds it *still unlocked*. For a password vault that's the
   wrong default — closing the app should require re-authentication.

Neither is solved by the core crypto; both live in the **unlock layer**.

## 2. Non-negotiable constraint: what actually protects the key

The vault's data is encrypted with a **DEK** (Data Encryption Key) that normally
lives *only* inside the key Worker's memory (`src/lib/worker/keyEngine.ts`) and is
never persisted in plaintext. Any "quick unlock" mechanism must store a **wrapped
copy of the DEK** locally so it survives a real app close. So the entire security
question reduces to:

> **What guards that wrapped DEK?**

There are only two honest answers, and they are *not* equally strong. The whole
strategy follows from taking that difference seriously.

## 3. The unlock hierarchy

Three tiers, strongest and most convenient first:

| Tier | Mechanism | Guards the DEK with | Offline brute-force | New secret to remember? |
|------|-----------|---------------------|---------------------|-------------------------|
| 1. **Device unlock** | WebAuthn platform authenticator + PRF | A 32-byte secret released by the phone's **secure element** only after the OS verifies you | **Impossible** — secret never leaves hardware | **No** — reuses the phone's own lock |
| 2. **App PIN** (fallback) | User-chosen PIN, Argon2id-stretched | A key derived from the PIN itself | **Feasible** — a copied IndexedDB can be ground offline | **Yes** — a separate PIN |
| 3. **Master password / recovery key** | Argon2id → KEK → unwrap DEK (the base scheme) | The password's own entropy | As strong as the password | It's the primary secret |

Tier 3 always works and is the ultimate fallback. Tiers 1–2 are per-device
conveniences layered on top.

## 4. Tier 1 — Device unlock (the hardware path)

**This is the primary, recommended mechanism.** It's implemented with WebAuthn's
**PRF extension** (`src/lib/unlock/webauthn.ts`):

- On enrollment we register a **platform authenticator** credential
  (`authenticatorAttachment: 'platform'`, `userVerification: 'required'`).
- The **PRF extension** lets us evaluate a stable 32-byte output for a fixed salt,
  but *only after a successful user verification*. That output is imported as an
  AES-GCM key and used to wrap the DEK. It cannot be recomputed from the stored
  blob — it comes out of the secure element.

### Why this already covers "pattern / PIN / fingerprint"

A recurring question during design: *"users unlock their phone with a pattern or
PIN — can we use that hardware security, not a PIN pad we draw ourselves?"*

Yes — and this tier **is** exactly that:

- The browser **cannot read** the phone's screen-lock secret. No web API exposes
  it. So we never see the pattern/PIN.
- But when the WebAuthn prompt fires with `userVerification: 'required'`, the
  **operating system** shows its *own native* prompt, backed by the same
  secure-element check the phone uses to unlock. On Android that prompt accepts
  **fingerprint, face, OR the device pattern/PIN/password**. A user with only a
  pattern gets asked for their pattern — verified by the OS, not by us.

So the "Unlock with this device" button is the pattern/PIN/fingerprint path. There
is **nothing to invent and nothing to forget** — it reuses what the user already
knows. That is why it's tier 1.

### There is no server

Simple Vault has no backend, so the WebAuthn `challenge` isn't verified by anyone —
it exists only to satisfy the API. **All** the security comes from the
authenticator gating the PRF evaluation behind user verification, plus AES-GCM
authentication when unwrapping the DEK. We are not doing remote authentication; we
are using the authenticator as a local, hardware-gated key-release mechanism.

## 5. Tier 2 — App PIN (the fallback, and why it's clearly weaker)

`src/lib/ui/PinPad.svelte` + `src/lib/unlock/pin.ts` implement a numeric PIN entry.
It's important to be honest about what this is and isn't:

- **It is NOT the phone's security.** It's a number pad our web page draws; the
  digits are checked in JavaScript. It has no connection to the device's
  screen-lock.
- **It is a separate secret the user invents** during setup (enter + confirm) and
  must remember. If they forget it, only the master password recovers the vault.
- **It is low-entropy.** A 4–6 digit PIN is 10⁴–10⁶ guesses. Anyone who copies this
  device's IndexedDB can grind it **offline**, bounded only by Argon2id's per-guess
  cost. Our 5-attempt lockout (`PIN_MAX_ATTEMPTS` in `vault.svelte.ts`) only stops
  casual guessing *through our UI* — it can't stop an offline attack.

Because of that, the PIN path:

- **Only appears when there is no platform authenticator** (`platformAuthAvailable`
  is false) — e.g. a desktop browser or an older device. On a modern Android/Chrome
  phone the user never needs it; tier 1 covers them.
- Is **labeled honestly** in the UI as an "app PIN (chosen here, not your phone's
  lock)" with a weaker-security note, so no one mistakes it for hardware security.

We kept it (rather than dropping it) so that devices without WebAuthn/PRF still get
*a* quick unlock instead of retyping the master password every time. The tradeoff is
explicit and surfaced to the user.

### Why not a "pattern" grid?

A pattern is just a PIN with a prettier keypad — same entropy, same offline-guessing
weakness. Users who want a real pattern already have it via tier 1 (their phone's
pattern, through the OS prompt). Drawing our own pattern grid would add code and
imply strength it doesn't have, so the software fallback is a plain PIN.

## 6. Auto-lock — making "closed" mean "locked"

This fixes problem #2 (the app staying unlocked after close). Implemented in
`vault.svelte.ts` as a **background-time policy**:

- On `visibilitychange → hidden` we stamp `hiddenAt` in `localStorage`.
- On return **and at every app launch** (`init()`), if the app spent longer than
  the configured delay in the background, we `lock()` — which clears the Worker DEK
  and the session copy — *instead of* silently resuming.
- The check runs at `init()` specifically so it works whether the app was merely
  suspended (SharedWorker alive) or fully killed and relaunched.

It's **configurable** (`AUTOLOCK_OPTIONS`): Immediately / 30s / 1m / 5m / Never
(default 30s). A short grace (30s) means a quick app-switch — e.g. to read a 2FA
code — doesn't force re-auth, but actually leaving the app does. `Never` preserves
the old always-open behavior for anyone who wants it (note: a hard kill still drops
the in-memory key regardless).

When it re-locks, the user is met with their tier-1/tier-2 unlock, so the flow feels
like "the phone's lock guards the app."

## 7. Data model & storage

One new IndexedDB meta record: `META_LOCAL_UNLOCK` (`src/lib/db/repository.ts`),
holding a single `LocalUnlocker` (`src/lib/unlock/types.ts`):

```
webauthn: { credentialId, prfSalt, wrappedDek }
pin:      { kdf, salt, wrappedDek, attempts }
```

`credentialId`, `prfSalt`, `salt`, and `wrappedDek` are stored as native
`Uint8Array` values. IndexedDB supports binary structured-clone values, so this
device-local data does not need Base64 conversion.

Key properties:

- **Device-local, never synced.** It lives in IndexedDB, not in the Drive envelope,
  so each device enrolls independently. Losing/wiping a device loses only its
  convenience unlocker, never the vault (recoverable via master password / recovery
  key / Drive).
- **The core envelope, KDF, and password/recovery paths are untouched.** This layer
  only *adds* an alternative way to unwrap the same DEK. `enrollment` reuses the
  existing `exportDek` seam; unlock reuses `restoreDek` — the exact machinery that
  already backed opt-in sessionStorage persistence. No new DEK exposure beyond what
  the app already did.

## 8. Key rotation & invalidation

- **Changing the master password rotates the DEK** (`changeMasterPassword`). The
  stored `wrappedDek` would then wrap the *old* key, so we **drop the local
  unlocker** on password change and prompt the user to re-enable it (which re-wraps
  the new DEK). Regenerating the recovery key does **not** rotate the DEK, so the
  unlocker stays valid there.
- **Import / wipe** clear IndexedDB (and thus the unlocker); the state flag is reset
  so the UI reflects "no app lock."

## 9. Limitations (deliberately accepted)

- **App PIN is offline-guessable** if the device storage is exfiltrated. Mitigated
  by Argon2id + UI lockout, surfaced in copy, and gated behind "no platform
  authenticator." Not a substitute for the master password.
- **PRF support isn't universal.** Modern Android/Chrome and iOS 18+ have it; older
  browsers don't. Those fall back to app PIN or master password. This is why tier 1
  is best-effort, not mandatory.
- **A hostile script on our own origin** that runs while unlocked can already reach
  decrypted data — the unlock layer doesn't change that surface (the DEK still lives
  in the Worker; this layer just adds ways to *restore* it). App integrity still
  depends on the PWA origin not being compromised.

## 10. File map

| File | Role |
|------|------|
| `src/lib/unlock/types.ts` | `LocalUnlocker` shape (webauthn / pin) |
| `src/lib/unlock/webauthn.ts` | Platform-authenticator enroll/unlock via PRF |
| `src/lib/unlock/pin.ts` | PIN → Argon2id wrapping key |
| `src/lib/app/vault.svelte.ts` | Orchestration: enroll/unlock, auto-lock policy, DEK-rotation invalidation |
| `src/lib/db/repository.ts` | `META_LOCAL_UNLOCK` storage + `deleteMeta` |
| `src/lib/ui/Unlock.svelte` | Unlock screen: device / app-PIN / password paths |
| `src/lib/ui/PinPad.svelte` | Numeric pad for the app-PIN path |
| `src/lib/ui/Settings.svelte` | Enroll/disable app lock + auto-lock delay control |

## 11. Testing note

The auto-lock and app-PIN paths are testable in any browser. **Device unlock
(WebAuthn) requires HTTPS and a real platform authenticator** and can't be exercised
headlessly — verify it on an actual Android/Chrome device and iOS 18+.
