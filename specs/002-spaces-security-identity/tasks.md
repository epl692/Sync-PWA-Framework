---

description: "Task list for Spaces, Security & Identity (002-spaces-security-identity)"
---

# Tasks: Spaces, Security & Identity

**Input**: Design documents from `/specs/002-spaces-security-identity/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md). Spec 001 is implemented and its suite is green.

**Tests**: INCLUDED and written first. Constitution Principle VIII requires test-first work, a contract suite for the Identity Provider, and property-based convergence tests. Within each phase, run the test tasks and confirm they FAIL before starting the implementation tasks.

**Organization**: Tasks are grouped by user story so each can be built and tested on its own. Story order follows priority (P1: US1, US2; P2: US3, US5, US4; P3: US6, US7). US5 comes before US4 because device revocation reuses key rotation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1 to US7, matching the stories in spec.md
- Paths follow plan.md (`packages/<name>/...`, `tests/e2e/`). `crypto`, `keystore`, `codec`, `authority`, `validators`, `rotation`, `shares`, `service` are folders under `packages/spaces/src/`

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Scaffold `packages/spaces` (`@sync/spaces`) with `package.json` and `tsconfig.json`. It MUST declare no runtime `dependencies`; it imports `@sync/core` as a peer
- [X] T002 [P] Scaffold `packages/identity-invite` (`@sync/identity-invite`) with `package.json` and `tsconfig.json`. Its only runtime dependency is `qrcode-generator`; it imports `@sync/spaces` as a peer
- [X] T003 [P] Add `packages/testkit/src/spaces/index.ts` (empty exports for now) and re-export it from `packages/testkit/src/index.ts`
- [X] T004 [P] Add root npm scripts `test:adversarial` (`vitest run packages/spaces/tests/adversarial`) and a `bench` entry for `packages/spaces/bench` in root `package.json`
- [X] T005 [P] Release-surface guard test in `packages/spaces/tests/unit/release-surface.test.ts`: `@sync/spaces` has zero runtime dependencies, `@sync/identity-invite` depends only on `qrcode-generator`, and neither imports `@sync/testkit` from `src/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core amendments, crypto, keystore, codec, authority fold, validators and the Identity Provider contract suite. Every story needs these.

**CRITICAL**: No user story work starts until this phase is complete

### 2a. Core amendments A-1 to A-7 (tests first)

See [contracts/core-amendments.md](./contracts/core-amendments.md).

- [X] T006 [P] A-1 test: a registered `PacketSigner` output appears in `sig` for local writes, signing input is the canonical envelope with `sig: null`, and a core with no signer is unchanged, in `packages/core/tests/integration/amendments/signer.test.ts`
- [X] T007 [P] A-2 test: after `rebuildSpace(space)` the `stateHash` equals that of a peer which received the same packets in valid order, and a packet that now fails validation is no longer visible, in `packages/core/tests/integration/amendments/rebuild.test.ts`
- [X] T008 [P] A-3 test: with a `SnapshotSealer` registered, a snapshot over a recording transport contains no plaintext marker; a snapshot with a bad signature is discarded and reported; a receiver without a sealer discards the sealed snapshot and catches up by packets, in `packages/core/tests/integration/amendments/snapshot-sealed.test.ts`
- [X] T009 [P] A-4 test: `core.channel('x')` messages reach a peer, are never persisted by the core, and the relay forwards `chan` messages between two clients that share a Space while storing nothing of them, in `packages/core/tests/integration/amendments/channel.test.ts` and `packages/relay-server/tests/chan-forward.test.ts`
- [X] T010 [P] A-5 and A-6 test: a `$sys.x` object is absent from `query({})`, present for `query({ type: '$sys.x' })`, and survives `compact()` when pinned, in `packages/core/tests/integration/amendments/hidden-pinned.test.ts`
- [X] T011 [P] A-7 test: more than `maxParkedPerAuthor` (default 1000) parked packets from one author: further packets from that author are not stored, not counted as held and not relayed, a `packet:rejected` event is emitted, and they are re-requested and accepted after the author's key arrives, in `packages/core/tests/unit/parked-limit.test.ts`

### 2b. Core amendments (implementation)

- [X] T012 A-1: add `PacketSigner` and `registerSigner()` in `packages/core/src/extension/types.ts` and `packages/core/src/extension/registry.ts`; add the signing step (encode → build envelope → sign → send validators → apply) in `packages/core/src/store/write.ts`
- [X] T013 [P] A-5: hide types starting with `$` from queries unless `spec.type` equals that exact type, in `packages/core/src/query/engine.ts`
- [X] T014 [P] A-6: add `CompactionPolicy.pin(type)` so pinned types and their packets are excluded from snapshots and never removed, in `packages/core/src/history/history.ts` and `packages/core/src/history/snapshot.ts`
- [X] T015 [P] A-7: add optional `peer` to `ValidatorContext` and enforce `limits.maxParkedPerAuthor` (default 1000; packets over the limit are not stored or counted as held, and are reported, so the summary stays honest and they can be re-requested later) in `packages/core/src/extension/types.ts` and `packages/core/src/store/apply.ts`
- [X] T016 A-2: implement `rebuildSpace(space)` (clear derived objects of the Space, re-run retained non-rejected packets in clock order through validators, mark now-invalid packets `rejected`) and expose it on `SyncCore` in `packages/core/src/core.ts` and `packages/core/src/store/apply.ts`
- [X] T017 A-3: add `SnapshotSealer` and `SnapshotValidator` hooks; when a sealer is present send `sealed` parts per scope plus `signer` and `sig`; discard snapshots that fail validation or cannot be opened, in `packages/core/src/sync/session.ts`, `packages/core/src/sync/messages.ts` and `packages/core/src/history/snapshot.ts`
- [X] T018 A-4: add `core.channel(name)` and the `chan` message (`{t, name, space, payload}`), size-limited by `limits.maxMessageBytes`, in `packages/core/src/sync/session.ts` and `packages/core/src/sync/manager.ts`; make `RelayHub` forward `chan` to other peers whose `hello.spaces` include the Space (or `*`), storing nothing, in `packages/relay-server/src/relayHub.ts`
- [X] T019 Update `specs/001-sync-core/contracts/extension-points.ts`, `specs/001-sync-core/contracts/sync-protocol.md` and `specs/001-sync-core/contracts/public-api.ts` with the amendments and their compatibility notes, and run the full 001 suite plus T006 to T011 to confirm gate S0 passes (`npm run test` and `npm run test:contract`)

### 2c. Crypto, keystore, codec (tests first)

- [X] T020 [P] Known-answer and unit tests for suite-1 in `packages/spaces/tests/unit/crypto.test.ts`: Ed25519 sign/verify, X25519 + HKDF wrap/unwrap (`info = "sync-grant/1" || scope || epoch || recipientDeviceId`), AES-256-GCM, `deviceId = base32(SHA-256(signPub))[0..128 bits]`, and `unsupported` reporting when Ed25519 or X25519 is missing. Vectors live in `packages/spaces/tests/vectors/`
- [X] T021 [P] Keystore tests with `fake-indexeddb` in `packages/spaces/tests/unit/keystore.test.ts`: device `CryptoKey`s are non-extractable, epoch keys are stored only wrapped by the local wrapping key, a database copy without the wrapping key yields no key bytes, counters persist, and `sync-keys` is never touched by sync, snapshots or export
- [X] T022 [P] Codec tests in `packages/spaces/tests/unit/codec.test.ts` against [contracts/crypto-envelope.md](./contracts/crypto-envelope.md): header layout (`fmt` 0x01, `scopeId` 16 B, `epoch` u32, `keyId` 8 B, `nonce` 12 B), AAD binds envelope fields so a transplanted body fails, changed `clock` or `author` fails, key chosen by `keyId`, `missing-key` and `malformed` results, unknown `fmt` parks, and a `grant/1` round trip

### 2d. Crypto, keystore, codec (implementation)

- [X] T023 [P] Implement suite-1 primitives, `deviceId` derivation and feature detection in `packages/spaces/src/crypto/suite.ts`, `packages/spaces/src/crypto/ids.ts` and `packages/spaces/src/crypto/support.ts`
- [X] T024 Implement the `sync-keys` IndexedDB keystore (stores `device`, `epoch-keys`, `counters`, `authority-cache`, `verified`, `invites-local` per [data-model.md](./data-model.md)) in `packages/spaces/src/keystore/keystore.ts` (depends on T023). Auto-rotate trigger at `rotateAtPackets = 2^31`
- [X] T025 [P] Implement key wrapping and unwrapping for grants in `packages/spaces/src/crypto/wrap.ts` (depends on T023)
- [X] T026 Implement the `aes-gcm-space/1` codec, the exported header parser, in `packages/spaces/src/codec/spaceCodec.ts` (key grants are ordinary control objects, not a second codec) (depends on T024, T025)
- [X] T027 [P] Implement the Ed25519 `PacketSigner` (`ed25519/1`, 64-byte signatures) in `packages/spaces/src/crypto/signer.ts` (depends on T023, T024)

### 2e. Authority fold and validators (tests first)

- [X] T028 [P] Fold unit tests in `packages/spaces/tests/unit/authority.test.ts` for every rule in [contracts/authority-rules.md](./contracts/authority-rules.md): Owner required, last-Owner rule, no self-promotion, invite expiry/role/`maxUses`, device `cutoff` (`clock < R` and `seq ≤ cutoff`), shares capped by Space role, self-service `$sys.device`, immutability (`update`/`delete` of `$sys.*` rejected), inert events kept in the log, unknown device defers
- [X] T029 [P] Edge-case fold tests in `packages/spaces/tests/unit/authority-conflicts.test.ts`: A removes B at clock 5 and B removes A at clock 6 leaves A as sole Owner; two Owners demote each other (earlier wins); the fold returns the list of inert events with the reason each was ignored (spec FR-005; notification delivery is tested in T070)
- [X] T030 [P] Property test in `packages/spaces/tests/property/authority-order.test.ts`: shuffling delivery of the same control events across 3 to 5 peers gives an identical authority state hash (≥ 10,000 runs, `CONVERGENCE_RUNS` / `CONVERGENCE_SEED`)
- [X] T031 [P] Validator tests in `packages/spaces/tests/unit/validators.test.ts`: envelope validator (bad signature rejects; unknown device key defers; revoked or beyond cutoff rejects; Viewer cannot write), body validator (role vs operation, Owner-only `$sys.*`, share role), snapshot validator (signer must be a current Owner or Editor), and verification order from crypto-envelope.md

### 2f. Authority fold and validators (implementation)

- [X] T032 [P] Define versioned `$sys.*` schemas (`genesis`, `member`, `device`, `device-revoke`, `invite`, `invite-revoke`, `epoch`, `keygrant`, `share`, `share-member`) with validation in `packages/spaces/src/authority/types.ts`. `maxDevicesPerUser = 10`, `maxInviteDays = 30`
- [X] T033 Implement the deterministic fold (sorted by clock, inert on failure, derived `SpaceId`; returns the list of inert events with the reason each was ignored) in `packages/spaces/src/authority/fold.ts` (depends on T032)
- [X] T034 Implement the authority state cache with incremental recompute from the earliest changed clock, kept in memory by the hub (`packages/spaces/src/authority/hub.ts`) and rebuilt from the log (depends on T024, T033)
- [X] T035 Implement the envelope validator, body validator and snapshot validator in `packages/spaces/src/validators/envelopeValidator.ts`, `packages/spaces/src/validators/bodyValidator.ts` and `packages/spaces/src/validators/snapshotValidator.ts`. Include a signature verdict cache (LRU, `verifiedCacheEntries = 50000`, rebuilt not trusted across versions) (depends on T026, T034)

### 2g. Identity Provider contract and test kit

- [X] T036 [P] Contract suite tests of the suite itself in `packages/testkit/tests/identityProviderContract.test.ts`: it fails for a deliberately broken provider (impure `verifyBinding`, accepts an expired invite, accepts a binding for the wrong user)
- [X] T037 Copy the contract types to `packages/spaces/src/identity/provider.ts` from [contracts/identity-provider.ts](./contracts/identity-provider.ts) and implement `identityProviderContract()` in `packages/testkit/src/spaces/identityProviderContract.ts` (user creation, pure and sync `verifyBinding`, link round trip, invite expiry and use limit, revoke)
- [X] T038 [P] Implement `stubIdentityProvider` (binding kind `stub-token/1`, no handshake network use) in `packages/testkit/src/spaces/stubIdentityProvider.ts`
- [X] T039 [P] Implement testkit helpers: adversarial packet-stream generator (forged signature, non-member, Viewer write, revoked author, backdated clock, tampered header, replay), plaintext marker scanner, and fake keystore in `packages/testkit/src/spaces/adversarial.ts`, `packages/testkit/src/spaces/plaintextScan.ts` and `packages/testkit/src/spaces/fakeKeystore.ts`

**Checkpoint**: amendments pass with 001 unchanged; codec, fold and validators pass their tests.

---

## Phase 3: User Story 1 - Create a Private Shared Space (Priority: P1) 🎯 MVP

**Goal**: A Space whose packets are encrypted on the authoring device; servers and relays see only routing metadata.

**Independent Test**: Create a Space, write objects, sync through the reference relay, inspect everything the relay stores or forwards for plaintext (quickstart S1, SC-002).

### Tests for User Story 1

- [X] T040 [P] [US1] Integration test in `packages/spaces/tests/integration/create-space.test.ts`: creating a Space makes the creator its Owner, generates the epoch-0 key, writes `$sys.genesis`, `$sys.epoch` and the creator's `$sys.device`, works with no transport, and every outgoing packet uses the current epoch key
- [X] T041 [P] [US1] Relay plaintext test in `packages/spaces/tests/integration/e2e-relay.test.ts` (SC-002): marker strings in object types, field names and values never appear in relay storage, packets, snapshot messages or `chan` traffic; only envelope metadata and the codec header are visible
- [X] T042 [P] [US1] Unsupported-crypto test in `packages/spaces/tests/unit/unsupported.test.ts`: when Ed25519 or X25519 is missing, `state === 'unsupported'`, an event is emitted, and no Space can be created and no plaintext fallback is used

### Implementation for User Story 1

- [X] T043 [US1] Implement the snapshot sealer (one sealed blob per scope per part) in `packages/spaces/src/codec/snapshotSealer.ts`; it is registered by T044, and T041 and the A-3 test run against it
- [X] T044 [US1] Implement `installSpaces()` registering codecs, signer, validators, sealer, compaction pin and the identity channel; throw if installed twice on one core, in `packages/spaces/src/service/install.ts` (depends on T012 to T018, T026, T027, T035, T043)
- [X] T045 [US1] Implement `create()`, `list()`, `session()` and `signUp()` using `ProviderHost` and the device record, in `packages/spaces/src/service/spaces.ts`. `SpaceId` derived per authority-rules.md
- [X] T046 [US1] Implement the `SecurityEvent` emitter and wire `packet:waiting-for-key`, `security:unsupported` in `packages/spaces/src/service/events.ts`
- [X] T047 [US1] Implement the release gate: a build test in `packages/spaces/tests/unit/release-gate.test.ts` that fails if `createSyncCore` can start in a release build with the plaintext codec as default, and export `requireSecureCodec()` from `packages/spaces/src/index.ts`

**Checkpoint**: US1 works alone. MVP.

---

## Phase 4: User Story 2 - Peers Enforce Roles (Priority: P1)

**Goal**: Every peer verifies signature and role; invalid packets are never applied or relayed.

**Independent Test**: Inject packets from a Viewer, a non-member and a forged signature; none is applied on any peer (quickstart S2, SC-001).

### Tests for User Story 2

- [X] T048 [P] [US2] Adversarial property test in `packages/spaces/tests/adversarial/adversarial.test.ts` using T039: ≥ 10,000 randomized streams across 3 peers; no invalid packet is applied or relayed, and valid ones converge (SC-001)
- [X] T049 [P] [US2] Integration test in `packages/spaces/tests/integration/reject-and-relay.test.ts`: a rejected packet is not forwarded, is counted by `rejectedCount()`, and emits `packet:rejected` with reason `bad-signature`, `not-member`, `role`, `revoked`, `beyond-cutoff` or `immutable-control`
- [X] T050 [P] [US2] Integration test in `packages/spaces/tests/integration/retroactive-rebuild.test.ts`: a packet applied before a removal with an earlier clock arrives is invalidated by `rebuildSpace`, `space:rebuilt` is emitted, and all peers reach the same `stateHash`

### Implementation for User Story 2

- [X] T051 [US2] Implement rejection reporting and `rejectedCount()` in `packages/spaces/src/service/rejections.ts`
- [X] T052 [US2] Trigger `rebuildSpace` when a newly applied control event changes authority at a clock earlier than already-applied packets from an affected device or role, in `packages/spaces/src/service/rebuild.ts` (depends on T016, T034)
- [X] T053 [US2] Apply `maxParkedPerAuthor` to packets deferred for unknown device keys and run `revalidate()` when a `$sys.device` arrives, in `packages/spaces/src/service/revalidate.ts`

**Checkpoint**: US1 and US2 pass together; all P1 stories done.

---

## Phase 5: User Story 3 - Invite Someone With a Link or QR (Priority: P2)

**Goal**: An Owner invites a member by link or QR with role, expiry and use limit; works offline over a local-network link; approval required by default.

**Independent Test**: Invite a device via QR with no internet, verify it decrypts and writes per its role (quickstart S3, S4, SC-004).

### Tests for User Story 3

- [X] T054 [P] [US3] Unit tests for the artifact, secret hash and `HMAC-SHA-256(secret, signPub ‖ nonce)` proof in `packages/identity-invite/tests/unit/invite.test.ts`: URL fragment encoding, expiry, secret never written to the Space log, only `SHA-256(secret)`
- [X] T055 [P] [US3] Contract test running `identityProviderContract` against the default provider in `packages/identity-invite/tests/contract/provider.test.ts`
- [X] T056 [P] [US3] Handshake integration test in `packages/identity-invite/tests/integration/join.test.ts`: approval required by default and automatic when chosen; `join-deny` for expired, used-up, revoked, bad proof or declined; interrupted handshake writes nothing and retries cleanly; a replayed `join-request` (same `inviteId` and `nonce`) is refused and writes nothing; a joiner who is already a member gets an idempotent grant; the SAS matches on both sides
- [X] T057 [P] [US3] Edge-case test in `packages/identity-invite/tests/integration/invite-race.test.ts`: two joiners race for a single-use invite, the earlier clock stays a member, the other becomes inert and an Owner rotates
- [X] T058 [P] [US3] Playwright tests `tests/e2e/invite-online.spec.ts` (relay) and `tests/e2e/invite-offline-webrtc.spec.ts` (network blocked, WebRTC manual signaling, timed under 60 s for SC-004), each checking the joiner reads existing history (all epochs) and writes per role

### Implementation for User Story 3

- [X] T059 [US3] Implement the default provider with `peer-chain/1` bindings (pure sync `verifyBinding`, `issueBinding`, `createUser`) in `packages/identity-invite/src/provider.ts`
- [X] T060 [P] [US3] Implement artifact encode/decode, secret hash and proof in `packages/identity-invite/src/invite.ts`
- [X] T061 [US3] Implement the `identity/1` handshake (`join-request`, `join-pending`, `join-grant`, `join-deny`) with ECIES sealing and 5-minute approval timeout in `packages/identity-invite/src/handshake.ts` (depends on T018, T059, T060)
- [X] T062 [P] [US3] Implement QR render with `qrcode-generator` and `BarcodeDetector` scanning with a paste-link fallback in `packages/identity-invite/src/qr.ts`
- [X] T063 [US3] Implement key grant writing (`$sys.keygrant` objects, and every held epoch in a join or link grant) in `packages/spaces/src/rotation/grants.ts`
- [X] T064 [US3] Implement `invite()`, `revokeInvite()`, `accept()` and the `join:request` approval event, writing `$sys.invite`, `$sys.invite-revoke`, `$sys.device` and `$sys.member add` in `packages/spaces/src/service/invites.ts`

**Checkpoint**: US3 works with US1 and US2.

---

## Phase 6: User Story 5 - Remove a Member (Priority: P2)

**Goal**: A removed member cannot read anything new; the last Owner cannot leave.

**Independent Test**: Remove a member, write new objects, verify the removed device cannot decrypt them (quickstart S6, SC-003).

### Tests for User Story 5

- [X] T065 [P] [US5] Integration test in `packages/spaces/tests/integration/remove-member.test.ts`: after removal the Space key rotates and 100% of new packets are undecryptable on the removed device; packets with `clock` after removal or `seq` above `cutoff` are rejected and counted; the last Owner cannot leave or be demoted; an Editor or Viewer can leave by authoring `member.remove` for themselves, and an Owner device then rotates the Space key and the user's shares
- [X] T066 [P] [US5] Rotation tests in `packages/spaces/tests/integration/rotation.test.ts`: concurrent rotations by two Owners leave both keys usable for decryption by `keyId`; the lowest-clock `$sys.epoch` is current; a member offline across several rotations decrypts everything after catching up on grants (FR-010); a grant to a device removed elsewhere is superseded by the next rotation; the 2^31 packet auto-rotation guard fires
- [X] T067 [P] [US5] Unit test in `packages/spaces/tests/unit/cutoff.test.ts`: the removal event records `cutoff[deviceId]` equal to the highest `seq` of that device the remover holds

### Implementation for User Story 5

- [X] T068 [US5] Implement rotation (new `$sys.epoch`, one `$sys.keygrant` per active recipient device, `keyId` selection, auto-rotate triggers `member-removed`, `device-revoked`, `invite-surplus`, `manual`) in `packages/spaces/src/rotation/rotate.ts`
- [X] T069 [US5] Implement `setRole()`, `remove()` and `leave()` (any member may remove themselves; an Owner device rotates on seeing it) with cutoff recording and the last-Owner guard in `packages/spaces/src/service/members.ts`
- [X] T070 [US5] Notify the author of an inert event (spec FR-005) via a new `SecurityEvent` kind `member:change-ignored` in `packages/spaces/src/service/events.ts` and `specs/002-spaces-security-identity/contracts/spaces-api.ts`; test first in `packages/spaces/tests/integration/inert-notify.test.ts` (the author device of an ignored event receives the event with its reason, and no other device does)
- [X] T071 [US5] Implement `members()` with devices and active status, and the `key:rotated` and `member:changed` events, in `packages/spaces/src/service/members.ts`

---

## Phase 7: User Story 4 - Link My Other Devices (Priority: P2)

**Goal**: A user adds a second device that receives all their Spaces; revoking a lost device rotates keys.

**Independent Test**: Link a second device, verify it receives all Spaces and its packets show the same user (quickstart S5).

### Tests for User Story 4

- [X] T072 [P] [US4] Integration test in `packages/identity-invite/tests/integration/link-device.test.ts`: the new device has its own key, receives every Space and share the user is in with all entitled epochs, and its packets are attributed to the same user and verified with its own key; the same holds when the user is only a Viewer in a Space (self-service `$sys.device` and own-device `$sys.keygrant`)
- [X] T073 [P] [US4] Integration test in `packages/spaces/tests/integration/revoke-device.test.ts`: revoking from another linked device rejects later packets (`seq` above cutoff or `clock` after), rotates every Space and share the user was in, and an Owner can remove a whole user whose only device was lost (spec Edge Case)
- [X] T074 [P] [US4] Test `maxDevicesPerUser = 10` is enforced and a self-service `$sys.device` is allowed regardless of role, in `packages/spaces/tests/unit/device-limits.test.ts`

### Implementation for User Story 4

- [X] T075 [US4] Implement `beginLink`/`completeLink` (`link-offer`, `link-accept`) in `packages/identity-invite/src/handshake.ts`
- [X] T076 [US4] Implement `linkDevice()`, `joinAsDevice()` and `revokeDevice()` (write `$sys.device` into every Space of the user, grant all entitled epochs, write `$sys.device-revoke` with cutoff, rotate) in `packages/spaces/src/service/devices.ts`

---

## Phase 8: User Story 6 - Share One Object Privately (Priority: P3)

**Goal**: An object inside a Space is visible only to its own share members; other Space members store and relay it but cannot read it; Space Owners outside the share have no access (FR-011a).

**Independent Test**: Create an override share; verify Space members outside it cannot decrypt the object (quickstart S7).

### Tests for User Story 6

- [X] T077 [P] [US6] Integration test in `packages/spaces/tests/integration/override-share.test.ts`: a share has its own members, roles and key; outsiders store and relay but get `missing-key`; share roles are capped by Space roles; a non-Space-member cannot be added; a Space Owner outside the share cannot read or edit; removing a user from the Space removes them from every share and rotates each
- [X] T078 [P] [US6] Test in `packages/spaces/tests/integration/share-snapshot.test.ts`: snapshot parts for a share are sent only to share members and are sealed with the share key

### Implementation for User Story 6

- [X] T079 [US6] Implement share binding (`obj → shareId` resolution, `scopeId` in the codec header, scoped role check in the body validator) in `packages/spaces/src/shares/binding.ts` and `packages/spaces/src/validators/bodyValidator.ts`
- [X] T080 [US6] Implement `share()`, `shareOf()`, `setShareRole()` with per-share rotation in `packages/spaces/src/shares/shares.ts` and `packages/spaces/src/rotation/rotate.ts`
- [X] T081 [US6] Restrict snapshot sending of share scopes to share members in `packages/spaces/src/codec/snapshotSealer.ts`

---

## Phase 9: User Story 7 - Swap the Identity Provider (Priority: P3)

**Goal**: A different provider works with no changes to Spaces, signing or encryption.

**Independent Test**: Run the contract suite against the default and the stub provider (quickstart S8, SC-005).

### Tests for User Story 7

- [X] T082 [P] [US7] Run `identityProviderContract` against the stub provider in `packages/testkit/tests/stubProvider.contract.test.ts`
- [X] T083 [P] [US7] Run the US1, US2 and US5 integration tests with the stub provider injected in `packages/spaces/tests/integration/stub-provider-swap.test.ts`, with no changes to non-provider code

### Implementation for User Story 7

- [X] T084 [US7] Fix any provider-specific assumptions found by T083 in `packages/spaces/src/service/` so only the `IdentityProvider` interface is used, and add `docs/writing-an-identity-provider.md` (contract, pure `verifyBinding` rule, how to run the suite)

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T085 [P] Edge-case tests in `packages/spaces/tests/integration/edge-cases.test.ts` for every spec Edge Case (quickstart S10): mutual removal, simultaneous single-use invite, backdated clock beyond cutoff, offline across rotations, photographed QR (needs approval), lost device with no other device
- [X] T086 [P] Benchmarks in `packages/spaces/bench/rotation.bench.ts` and `packages/spaces/bench/verify.bench.ts` against the 001 reference profile: rotation for 100 devices < 2 s, ≥ 2,000 verifications/s, measured against absolute bounds (see research R-18; the relative "30% slower than plaintext" goal was dropped as meaningless in memory) (quickstart S11)
- [X] T087 [P] Add `packages/spaces/tests/vectors/` README and a test that regenerates nothing but reproduces the stored vectors byte for byte
- [ ] T088 Update `specs/002-spaces-security-identity/research.md` R-07 and `plan.md` to say the author of an inert membership event is notified (spec FR-005), and align `contracts/authority-rules.md`
- [ ] T089 [P] Write the compatibility note for signing, encryption and the snapshot wire change in `specs/002-spaces-security-identity/contracts/crypto-envelope.md` (verify it matches the implementation) and record deviations
- [ ] T090 Security review of `packages/spaces` and `packages/identity-invite` (key handling, invite secrets, constant-time proof compare, replay of `join-request`), and fix findings
- [ ] T091 Run quickstart S0 to S11 end to end; record results in `specs/002-spaces-security-identity/validation.md`; confirm manual check S9 on two real devices

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none
- **Foundational (Phase 2)**: needs Setup. Blocks all stories. Inside it: 2a/2b (amendments) first and independent of 2c to 2g; 2c to 2d need T023 first; 2e to 2f need the codec (T026) and keystore (T024); 2g needs only the contract types
- **US1 (Phase 3)** and **US2 (Phase 4)**: need Phase 2. US2 needs US1's `installSpaces` (T044)
- **US3 (Phase 5)**: needs US1 and US2, and T018 (channel) plus T037 (contract suite)
- **US5 (Phase 6)**: needs US1 and US2. Reuses grants (T063) from US3
- **US4 (Phase 7)**: needs US5 (rotation) and US3 (handshake file)
- **US6 (Phase 8)**: needs US5 (rotation)
- **US7 (Phase 9)**: needs US1, US2 and US5 for the swap test, and T038
- **Polish (Phase 10)**: needs the stories you intend to ship

### Within Each Phase

- Tests are written first and must FAIL before implementation starts
- Crypto before keystore before codec; codec before validators; validators before the service layer
- Core amendments land and pass with 001 unchanged (T019) before any spaces code is used

### Parallel Opportunities

- Setup T002 to T005 after T001
- Amendment tests T006 to T011 together; T013, T014, T015 together
- T020 to T022 together; T028 to T031 together; T036 and T038 and T039 together
- Story test tasks marked `[P]` together within a story
- US3 and US5 can proceed in parallel once T063 (grants) is done; US6 and US7 can run in parallel after US5

---

## Parallel Example: Foundational tests

```bash
Task: "A-1 signer test in packages/core/tests/integration/amendments/signer.test.ts"
Task: "A-2 rebuild test in packages/core/tests/integration/amendments/rebuild.test.ts"
Task: "Crypto known-answer tests in packages/spaces/tests/unit/crypto.test.ts"
Task: "Authority fold tests in packages/spaces/tests/unit/authority.test.ts"
Task: "Order-independence property test in packages/spaces/tests/property/authority-order.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 (Setup), then Phase 2 (Foundational), including the core amendments gate (T019)
2. Phase 3 (US1)
3. **Stop and validate** with quickstart S1: an encrypted Space syncs through the relay and the relay sees no plaintext

### Incremental Delivery

1. Setup, Foundational, US1: encrypted single-user Space
2. US2: peers enforce roles (completes both P1 stories and the release-blocking guarantee; 001 may now ship)
3. US3: multi-user via invite and QR
4. US5: removal and rotation
5. US4: multiple devices
6. US6: private objects; US7: provider swap proof
7. Polish: edge cases, performance, security review

### Notes

- No release may ship without T047 (release gate) passing
- Any change to the envelope, codec header, signing input or snapshot wire format needs a compatibility note (T089)
- Control events (`$sys.*`) are create-only and never compacted; do not add code paths that update or delete them
- Modules must never receive the keystore or signer; only the `Spaces` API (see `contracts/spaces-api.ts`)
- Commit after each task or logical group
