# Implementation Plan: Spaces, Security & Identity

**Branch**: `002-spaces-security-identity` | **Date**: 2026-10-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-spaces-security-identity/spec.md`

## Summary

Add multi-user Spaces, end-to-end encryption, signed packets that every peer verifies, key rotation, per-object override shares, and a pluggable Identity Provider with an invite/QR default, all as plugins on the finished 001 core.

Technical approach (details in [research.md](./research.md)):

- **Web Crypto only, one suite, no runtime dependencies** for security: Ed25519 signatures, X25519 + HKDF key wrapping, AES-256-GCM payloads (R-01). Private keys are non-extractable and live in a separate `sync-keys` IndexedDB (R-03).
- **No envelope change.** The encrypting codec puts `scope, epoch, keyId` in the first bytes of `body`; `sig` is the Ed25519 signature the 001 envelope contract already reserved (R-04, R-05). Device IDs become hashes of the public key (R-02).
- **Authority is a deterministic fold over create-only, signed `$sys.*` objects** in the Space. Roles, members, devices, invites, epochs and shares all derive from it. Conflicts are replayed in clock order; conflicting events become inert, which also guarantees at least one Owner (R-06, R-07).
- **Removal cuts off by clock and by sequence number**, so a revoked device cannot backdate its way back in (R-08). Rotation sends new keys only to remaining devices; concurrent rotations are harmless because keys are found by `keyId` (R-09).
- **Late-arriving control events** trigger a bounded `rebuildSpace` so all peers converge (R-10).
- **Review of 001 found gaps this feature must close first**: no signing hook, plaintext and unsigned snapshots, no way to carry the join handshake, and no way to exempt control events from compaction. They are delivered as seven additive core amendments (A-1 to A-7) before any spaces code ([contracts/core-amendments.md](./contracts/core-amendments.md)).
- **Identity is a thin provider contract** covering who a user is, device bindings, and how invites and device links travel. The framework keeps all crypto and authority. The default provider does invite links/QR with approval, expiry and use limits; offline join runs over the 001 WebRTC manual-signaling transport (R-13, R-14).

**Clarifications applied**: offline joining is **local network + WebRTC manual signaling in every modern browser**, iOS included (Web Bluetooth cannot connect two browsers, 001 R-01), and FR-005 is clock-order replay with inert conflicting events and a notification to the author (R-07). Both are now in the spec (`/speckit-clarify`, 2026-10-21).

## Technical Context

**Language/Version**: TypeScript 5.x strict, ES2022; Node 20 LTS for tooling and relay.

**Primary Dependencies**:
- `packages/spaces`: **none at runtime** (Web Crypto, IndexedDB).
- `packages/identity-invite`: `qrcode-generator` (MIT, ~20 KB, zero deps) for rendering QR codes. Justification: a correct QR encoder is ~800 lines of error-correction and masking code; it is display-only and isolated to this optional package. Scanning uses the platform `BarcodeDetector`, with a paste/link fallback, so no scanning library ships.
- `packages/relay-server`: no new dependency (adds `chan` forwarding).
- Dev/test: existing `vitest`, `fast-check`, `fake-indexeddb`, `@playwright/test`.

**Storage**: Control events and data use the 001 stores unchanged. Keys, epoch keys, counters, the authority cache and the verification cache live in a separate IndexedDB database `sync-keys` (R-16). No change to the `StorageAdapter` contract.

**Testing**: Vitest for unit, contract and integration. fast-check for adversarial packet streams (SC-001) and order independence of the authority fold. Known-answer vectors for the codec, grants and signatures. Playwright (Chromium) for relay join, WebRTC offline join (timed against SC-004) and device link. Plaintext-scan test against the relay (SC-002).

**Target Platform**: Evergreen browsers with Web Crypto Ed25519/X25519 (Chrome/Edge 137+, Safari 17+ incl. iOS, Firefox 129+), Node 20+. Where unsupported, the layer reports `unsupported` and creates no Spaces. No plaintext fallback.

**Project Type**: Library monorepo, two new packages added to the 001 workspaces, plus additive changes to `core`, `relay-server` and `testkit`.

**Performance Goals**: Join via QR with no internet < 60 s (SC-004; measured about 4 s). Rotation for 100 devices < 2 s on the phone profile (measured about 1 s). Signature verification ≥ 2,000 packets/s on the phone profile (measured 2,600 to 3,600). Ingest of encrypted packets is bounded in absolute terms (about 350 to 550/s on the phone profile) rather than relative to plaintext; see research R-18. Main thread never blocked (async `crypto.subtle`, batched concurrent verification, 001 constraint).

**Constraints**: Offline-first: everything except delivering keys to other devices works with no transport. Secret material never leaves the device unwrapped. Modules never receive the keystore. Static-hostable: no server needed beyond the optional relay.

**Scale/Scope**: Up to 100 member devices per Space, 10 devices per user, ≤ 10,000 control events per Space. Larger groups would need a tree-based group key scheme (R-09 alternatives), out of scope for v1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Offline-first | PASS | Creating a Space, writing, removing a member and rotating are all local operations that complete with no transport. Only delivering keys and handshakes need a peer, and they queue. Join offline works over a local WebRTC link. |
| II. Everything is a Syncable Object | PASS | Membership, devices, invites, epochs and shares are `$sys.*` Syncable Objects in the Space, not a side store. Local key material is not synced data (it is a secret, not application data), and is kept out of the object model on purpose. |
| III. Packets are the only way state changes | PASS | Control changes are packets through the same apply path. The authority fold is a pure function of the packet set, so the commutative/idempotent property extends to it, with property tests. `rebuildSpace` replays packets; it does not mutate outside the pipeline. |
| IV. Transport agnostic | PASS | No transport is trusted with plaintext or authority. Handshakes use an abstract channel, so relay, WebRTC or any future transport carries them. |
| V. Zero-trust, E2E | PASS | This feature implements it: encrypt before leaving, sign every packet, verify signature and role on every peer, relays see envelope metadata only. Snapshots, which 001 leaves plaintext and unsigned, are sealed and signed (A-3). The plaintext test codec stays out of the release entry point. |
| VI. Modular | PASS | `spaces` and `identity-invite` are plugins registered through the 001 extension points. Identity Provider is a contract with a stub implementation. Modules get the Spaces API, never keys. |
| VII. Static-hostable | PASS | No server needed. Invite links keep the secret in the URL fragment, which static hosts never receive. |
| VIII. Contract-tested, test-first | PASS | `identityProviderContract()` ships in testkit. Adversarial and order-independence property tests. Tasks order tests before implementation, and amendments before features. |

**Technical constraints**: strict TS; Web Crypto for signing and encryption; IndexedDB; one justified dependency (`qrcode-generator`, display only). Schemas: `$sys.*` types are versioned and validated by the authority rules.

**Compatibility note (required by Development Workflow, touching signing and encryption):** [contracts/crypto-envelope.md](./contracts/crypto-envelope.md#compatibility) gives the rules for unknown codec formats, unknown signature lengths, and unknown `$sys.*` types: keep, relay, never apply. The core amendments are additive and listed with their compatibility in [contracts/core-amendments.md](./contracts/core-amendments.md). The one wire addition is to the `snapshot` message (sealed objects, signer, signature); old receivers discard it safely.

**Post-design re-check (after Phase 1):** PASS. Two items were examined and justified rather than waived: (1) the `qrcode-generator` dependency (display only, isolated); (2) key material in a separate IndexedDB outside the object model, which is a secrets store and not synced application data, so Principle II is not bypassed. Four problems with 001 and with the spec's assumptions were found during design and resolved above: plaintext/unsigned snapshots (R-11), clock-only revocation (R-08), non-convergence under retroactive authority changes (R-10), and Bluetooth offline join (R-14).

## Project Structure

### Documentation (this feature)

```text
specs/002-spaces-security-identity/
├── plan.md              # This file
├── research.md          # Phase 0: decisions, rationale, alternatives
├── data-model.md        # Phase 1: entities, stores, state transitions
├── quickstart.md        # Phase 1: validation scenarios
├── contracts/
│   ├── crypto-envelope.md     # codec body, grant, signature, verification order, compatibility
│   ├── authority-rules.md     # $sys.* events, deterministic fold, role table
│   ├── join-protocol.md       # invite artifact, join/link handshake messages
│   ├── core-amendments.md     # A-1..A-7 additive changes to @sync/core and relay
│   ├── identity-provider.ts   # Identity Provider contract + contract suite signature
│   └── spaces-api.ts          # app-facing Spaces API and security events
└── tasks.md             # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

```text
packages/
├── core/                    # AMENDED (A-1..A-7): signer hook, rebuildSpace, sealed/signed snapshots,
│   └── src/                 #   channel, hidden `$` types, compaction pin, parked limit
├── relay-server/            # AMENDED: forward `chan` messages by Space (stores nothing of them)
├── testkit/                 # ADDED: identityProviderContract, stubIdentityProvider, adversarial stream generator,
│                            #   plaintext scanner, fake keystore
├── spaces/                  # NEW  @sync/spaces
│   ├── src/
│   │   ├── crypto/          # suite-1 primitives, canonical sign input, HKDF, wrap/unwrap, ids
│   │   ├── keystore/        # `sync-keys` IndexedDB: device keys, epoch keys, counters, caches
│   │   ├── codec/           # aes-gcm-space/1 codec, snapshot guard (key grants are ordinary control objects)
│   │   ├── authority/       # $sys.* schemas, fold, state cache, incremental recompute
│   │   ├── validators/      # envelope validator, body validator, snapshot validator
│   │   ├── rotation/        # rotate/grant/cutoff, auto-rotate, surplus-invite handling
│   │   ├── shares/          # override share binding and scoped keys
│   │   ├── service/         # installSpaces(): Spaces API, events, provider host
│   │   └── index.ts
│   └── tests/{unit,property,adversarial,contract,integration,vectors}/
└── identity-invite/         # NEW  @sync/identity-invite (default provider)
    ├── src/
    │   ├── provider.ts      # IdentityProvider implementation (peer-chain bindings)
    │   ├── invite.ts        # artifact encode/decode, secret hash, proof
    │   ├── handshake.ts     # join + link protocol on channel identity/1
    │   ├── qr.ts            # QR render (qrcode-generator), BarcodeDetector scan with fallback
    │   └── index.ts
    └── tests/{unit,contract,integration}/
tests/e2e/                   # Playwright: invite-online, invite-offline-webrtc, link-device, remove-member
```

**Structure Decision**: Two new packages keep concerns separate. `spaces` holds everything the framework must own (crypto, keys, authority, validators), so no provider can weaken security. `identity-invite` holds only the replaceable part, which proves the contract (SC-005) by being swappable for the stub in the same test suite. Core changes are limited to additive hooks so 001's behavior and tests are unchanged without these plugins. `testkit` carries test-only pieces so none ships in a release bundle.

## Phasing for tasks

`/speckit-tasks` should order work as: **A** core amendments with tests (gate S0) → **B** crypto, keystore, codec with known-answer tests → **C** authority fold and validators with adversarial and order-independence property tests → **D** Spaces service, rotation, removal (Stories 1, 2, 5) → **E** identity contract, testkit suite, stub provider, default provider, invites and QR (Stories 3, 7) → **F** device linking (Story 4) → **G** override shares (Story 6) → **H** edge cases, performance, release gate. Stories map to priorities P1: 1, 2; P2: 3, 4, 5; P3: 6, 7.

**Release gate**: 001 ships plaintext-capable in development. A release build must import `@sync/spaces` and must fail to start `createSyncCore` with the plaintext codec as default; verified by a build test.

## Risks (accepted for v1, each with a test or a doc note)

| Risk | Mitigation / why accepted |
|---|---|
| Any script in the page can ask the keystore to sign/decrypt | Modules get no keystore handle; enforce in 003's module host. Non-extractable keys prevent exfiltration |
| A stolen unlocked device can revoke the user's other devices | Same trust as holding the device. Owner can re-invite. No recovery by design (spec) |
| Editor-signed snapshot can carry wrong field values | Editors already can write any non-control field. Control events are never in snapshots (R-11) |
| Withheld packets below a cutoff can be released later | Indistinguishable from slow honest delivery; bounded by what was really authored (R-08) |
| Removals older than the retention window are final | Stated limit; configurable retention (R-10) |
| Owner grants new epoch to a device already removed elsewhere (offline) | Rotates again on learning; removed members keep what they had (spec assumption) |
| Spam of deferred packets from unknown authors | `maxParkedPerAuthor`: packets over the limit are not stored or counted as held, and are reported (A-7) |
| Relay learns recipient device IDs of grants and share grouping | Allowed metadata (FR-006); documented in R-04, R-09 |

## Complexity Tracking

No constitution violations. Noted for transparency:

| Item | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Two packages instead of one | Keeps the replaceable identity part separate from the part the framework must own; makes SC-005 testable | One package would let a provider reach into keys, or force an org-login provider to pull invite/QR code |
| Seven core amendments | 001 lacked a signing hook, sealed snapshots, a handshake channel and compaction exemptions that Principle V requires | Working around them in the plugin would mean forking packet handling or leaving snapshots plaintext |
| `rebuildSpace` replay | Needed for convergence when authority changes retroactively (Principle III) | Accepting divergence breaks the constitution; a multi-version field store is far larger |
| Separate `sync-keys` database | Secrets must not enter sync, snapshots or export | Storing keys as Syncable Objects would replicate them |
