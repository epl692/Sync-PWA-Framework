# Research: Spaces, Security & Identity

Every open item from the Technical Context is resolved here. Each entry gives the decision, the rationale, and the alternatives considered. Spec 001 decisions (R-01 to R-0x in [../001-sync-core/research.md](../001-sync-core/research.md)) are taken as given.

## R-01: One cipher suite, Web Crypto only, no fallback

- **Decision**: A single suite, identified as `suite-1`: **Ed25519** signatures, **X25519** key agreement, **HKDF-SHA-256**, **AES-256-GCM**, **SHA-256**. All from `crypto.subtle`. Zero runtime dependencies. If `crypto.subtle` lacks Ed25519 or X25519, the security layer reports `unsupported` at startup and refuses to create or open Spaces. It never falls back to plaintext or to a weaker suite.
- **Rationale**: Ed25519 and X25519 are in Chromium, Safari and Firefox evergreen releases and in Node 20+. One suite avoids negotiation, downgrade attacks and a second test matrix. The suite ID is a versioned string (`aes-gcm-space/1` for the codec, `ed25519/1` for signatures), so a later suite is an additive change under the compatibility rules in [contracts/crypto-envelope.md](./contracts/crypto-envelope.md#compatibility).
- **Alternatives**: ECDSA/ECDH P-256 as a fallback (works on older browsers, doubles the test matrix, and invites downgrade logic); `libsodium` or `tweetnacl` (a runtime dependency, against the constitution's minimum-dependency rule, to cover browsers we do not target); ChaCha20-Poly1305 (not in Web Crypto).

## R-02: Self-certifying device IDs and user IDs

- **Decision**: `deviceId = base32(SHA-256(signPublicKey))[0..128 bits]`. `userId = deviceId of the user's first device` (the *genesis device*). Both are passed to the core through the existing `Config.deviceId`, so the envelope format does not change.
- **Rationale**: Spec 001 says the device ID is a random 128-bit value created at install. Making it a hash of the public key binds the ID to the key without any certificate, so the first packet from a device can be verified from its public key alone once that key is known, and nobody can squat another device's ID. 128 bits of hash output is collision-safe for this purpose.
- **Consequence**: the public key must still reach peers. It travels in the Space's `$sys.device` record (R-06). A packet from a device whose key a peer has not seen yet is **deferred**, not rejected.
- **Alternatives**: random IDs plus certificates (every verification needs a lookup and a chain, and the ID is squattable); deriving the ID from the user key (devices would share an ID, which breaks the per-author `seq` rule in 001).

## R-03: Key hierarchy and where keys live

- **Decision**:
  - **Device keys**: an Ed25519 signing pair and an X25519 agreement pair, generated with `extractable: false`, stored as `CryptoKey` objects in a dedicated IndexedDB database `sync-keys`. This database is separate from the synced stores and is never included in snapshots, exports or sync.
  - **Epoch keys** (AES-256-GCM, random 256-bit): one per Space (or override share) per epoch. They must be exportable once, to wrap them for other members. They are stored in `sync-keys` as ciphertext, wrapped by a per-device **local wrapping key** (non-extractable AES-GCM `CryptoKey`). A copy of the database without the wrapping key is useless.
  - **Wrapping for members** ("key grant"): ephemeral X25519 key, ECDH with the recipient's X25519 public key, HKDF-SHA-256 with `info = "sync-grant/1" || scope || epoch || recipientDeviceId`, then AES-256-GCM over the epoch key.
- **Rationale**: Non-extractable device keys mean malware or an XSS bug in a module cannot read the private key bytes; it can only use the key while the page is open. This is the best the platform offers. Wrapping epoch keys at rest narrows the window for a cold IndexedDB dump.
- **Residual risk (documented, not solved)**: any script in the page can ask the keystore to sign or decrypt. Modules (spec 003) therefore must not receive the keystore; they get the `SyncCore` API only. This is a rule for 003's module sandbox, recorded in [contracts/spaces-api.ts](./contracts/spaces-api.ts).
- **Alternatives**: passphrase-derived keys (a UX cost with no v1 requirement, and account recovery is out of scope); storing raw epoch keys in IndexedDB (readable by any IndexedDB dump); WebAuthn/passkeys for the device key (not available for arbitrary signing).

## R-04: Payload encryption (`aes-gcm-space/1`)

- **Decision**: The codec output (the packet `body` bytes) is `header || nonce || ciphertext`. The header is binary and readable by relays: `[fmt u8 = 1][scopeId 16 B][epoch u32][keyId 8 B]`. `scopeId` is the Space or override-share ID, `keyId` is the first 8 bytes of SHA-256 of the epoch key. The nonce is a fresh random 96-bit value. AAD is the canonical encoding of the envelope fields `v, id, author, seq, space, clock, codec` followed by the header bytes.
- **Rationale**:
  - FR-006 allows the epoch to be visible. Putting it in the codec output rather than a new envelope field means **no envelope change**, so the 001 compatibility table is unaffected.
  - The signature (R-05) covers the whole envelope including `body`, so the header is signed.
  - AAD binds the ciphertext to its envelope: a body cannot be transplanted into another packet, and an attacker cannot change `clock` or `author` without the tag failing.
  - `keyId` lets a reader pick the right key when two Owners rotated concurrently (R-09), without trial decryption.
  - Random 96-bit nonces are safe up to about 2^32 packets under one key. Epoch rotation is not needed for that limit in v1 scale (families, teams; see Scale/Scope), but the codec enforces a per-key counter and auto-rotates at 2^31 as a guard.
- **Leaks to relays (by design, FR-006)**: `space, author, seq, clock, codec`, plus `scopeId, epoch, keyId`. A relay learns that a group of packets belongs to the same override share, but not what it contains or who is in it.
- **Alternatives**: a deterministic nonce from `(author, seq)` (unique per author but two authors sharing a key could collide, which is catastrophic for GCM); an envelope-level `epoch` field (needs a format change); XChaCha (not in Web Crypto).

## R-05: Signing and verification

- **Decision**: The signature is Ed25519 over the **canonical encoding of the envelope with `sig = null`**, exactly as [../001-sync-core/contracts/packet-envelope.md](../001-sync-core/contracts/packet-envelope.md) specifies. Verification is split in two validators:
  1. **Envelope validator** (works without decoding): checks the signature against the author device's public key, then checks that the author is an active device of a user who is a member of the Space with a role that can write at all (Owner or Editor), and that `seq` is within the removal cutoff (R-08). It runs on every packet, including ones the device cannot decrypt (override shares it is not in).
  2. **Body validator** (needs the decoded body): checks the operation against the author's role in the scope (Space or override share), including Owner-only `$sys.*` types.
- **Rationale**: This is the split the 001 `PacketValidator` contract already allows (`body` is `undefined` for packets that cannot be decoded). Non-members of an override share can still refuse forged packets, so a rejected packet is never relayed (User Story 2, scenario 4).
- **Core gap**: the 001 write path builds the envelope with `sig: null` and has no signing step. See amendment A-1 in [contracts/core-amendments.md](./contracts/core-amendments.md).
- **Alternatives**: signing the plaintext body (relays could not verify, and the signature would leak plaintext identity); MAC with the Space key (any member could forge any other member, which defeats role enforcement).

## R-06: Authority state is a deterministic fold over signed control packets

- **Decision**: Membership, roles, device bindings, invites, key epochs and override shares are stored as **immutable, create-only objects with reserved types `$sys.*`** in the Space (FR-004). The *Authority State* of a Space is a pure function of the set of these objects:

  ```
  authority(space) = fold( sort(control events by clock) , initial = genesis )
  ```

  Rules are in [contracts/authority-rules.md](./contracts/authority-rules.md). The result is cached and recomputed from the earliest changed event when a new one arrives.
- **Why objects**: it reuses the packet pipeline (Principle III) and the Space's sync. A new member gets the control history through normal sync. No second protocol.
- **Create-only**: the validator rejects `update` and `delete` for any `$sys.*` type. History cannot be rewritten. A role change is a new event, not an edit. This also avoids using the field-wise LWW merge for something it does not model well.
- **Alternatives**: a single mutable `members` object with LWW fields (two Owners editing offline silently overwrite each other, and the "at least one Owner" rule cannot be enforced); a separate control channel outside the packet log (new sync path, new storage, new tests); a blockchain-style hash chain (heavier than needed, and a total order is already given by the HLC with device tiebreak).

## R-07: Resolving concurrent membership changes (FR-005 assumption revisited)

- **Decision**: The spec's assumption was "per-member last-writer-wins, with removal winning ties". The plan **refines** it: control events are replayed in total clock order, and an event takes effect only if, **at that point of the replay**, its author is an Owner and the event keeps the Space valid (at least one Owner remains). An event that fails this test is **inert** (kept in the log, no effect), not rejected. This is deterministic on every peer because the clock order is total (the HLC string, ties broken by device ID).
- **Examples** (Edge Cases in the spec):
  - A removes B at clock 5, B removes A at clock 6, both offline. A's event applies. B was removed at 5, so B's event at 6 is inert. Result on every peer: A is the only Owner.
  - Two Owners each demote the other: the first by clock wins, the second is inert.
  - Last-Owner rule (FR-003): an event that would remove or demote the final Owner is inert. The author's UI also blocks it up front, so inert events only appear from races.
- **Effect on "removal wins ties"**: ties on clock cannot occur because the device ID is in the clock. The original wording is covered by the total order.
- **Alternatives**: removal always wins (an Owner who was removed concurrently could still remove others, and the result depends on delivery order unless every event is replayed anyway); quorum or voting (not requested, much more machinery).

## R-08: Revocation cutoff by sequence number, not only by clock

- **Problem**: FR-009 says reject packets from a revoked device whose clock is after the revocation. A revoked device controls its own clock and can backdate. For packets under an old epoch key it still holds, a clock check alone does not stop it.
- **Decision**: Every removal/revocation event carries `cutoff: { [deviceId]: seq }`, the highest `seq` of that device **that the remover has held**. After the event, a packet from that device is valid only if **both** `clock < removal clock` **and** `seq ≤ cutoff[deviceId]`. Because a packet ID is `author:seq`, a revoked device cannot author a *new* packet with a `seq` that the remover already holds (duplicates are dropped by ID). It can only use `seq` values above the cutoff, which are rejected.
- **Accepted trade-off**: honest offline edits by the removed member that the remover had not yet received, with `seq` above the cutoff, are discarded. That is the safe side: they were authored without knowing of the removal. The UI reports "N changes by a removed member were not accepted".
- **Not solved**: a malicious device that **withheld** packets with `seq` below the cutoff (a gap the remover never received) can release them later. Those packets are accepted if their clock is before the removal. This is bounded by what the device had really authored before removal, so it is the same as an honest slow delivery and cannot be told apart from it. Documented in Risks.
- **Late arrival of the removal itself**: a peer may apply a packet before it learns of an earlier removal. The authority state then changes retroactively. See R-10 (rebuild).

## R-09: Key rotation, concurrency and catch-up (FR-008, FR-010)

- **Decision**:
  - A rotation is two things written by the rotating Owner: a `$sys.epoch` event `{scope, epoch, keyId, prevKeyId}` (signed, create-only) and one `$sys.keygrant` per **active** recipient device, holding the new epoch key wrapped for that device.
  - New writes use the **current epoch**, defined as the highest epoch number in the authority fold; among events with the same number, the lowest clock wins.
  - Concurrent rotations (two Owners both create epoch N+1) produce two keys. Both keys stay valid for **decrypting** (looked up by `keyId`), so no packet written in the confusion is lost. Writers move to the fold winner as soon as they see it. The next rotation covers both.
  - **Catch-up**: key grants are ordinary objects in the Space log, so an offline member receives every grant addressed to it through normal sync, then calls `revalidate()` and the parked packets decrypt. A joiner gets **all epoch keys the Space still holds** in its join grant, so it can read history (`JoinPolicy.history = 'all'`, default). `'from-join'` gives only the current epoch.
  - Removal triggers rotation of the Space key **and** of every override share the removed user was in. A Viewer or Editor leaving by choice is the same as a removal.
  - A grant that arrives for a device later removed is harmless: the removal supersedes, and the next rotation excludes the device.
- **Grants are not encrypted under the Space key** (a new device has no key yet). They use the `grant/1` codec: the body is cleartext JSON `{to, scope, epoch, keyId, wrapped}`, and `wrapped` is only readable by `to`. Relays learn *which device was granted which epoch of which scope*, which they can already infer from traffic. This is the one place a recipient device ID is visible.
- **Time-of-check gap**: an Owner who has not yet seen a removal can still grant the new epoch to the removed device. When the Owner learns of the removal, it rotates again. The spec's "removed members keep what they already decrypted" assumption covers the rest.
- **Alternatives**: a forward-only key chain, K(n+1) = H(K(n)) (a removed member could derive every future key, which defeats the purpose); a group ratchet such as TreeKEM/MLS (sub-linear rotation cost, but a large dependency and complexity; revisit if a Space needs hundreds of members); one Space key per sender (more keys to distribute, no gain).

## R-10: Retroactive authority changes require a rebuild, not an in-place undo

- **Problem**: the 001 merge is commutative and idempotent but cannot "un-apply" a packet. Authority is evaluated when a packet arrives, but a removal event with an earlier clock may arrive later, making a packet that was already applied invalid. Peers that saw the events in different order would diverge, which breaks convergence (Principle III).
- **Decision**: add a core primitive `rebuildSpace(space)` (amendment A-2): clear the derived objects of the Space and re-apply every retained, non-rejected packet from the log in clock order through the validators. Run it only when a newly applied control event changes the authority state **at a clock earlier than packets already applied** from affected devices. Normal operation (events arriving roughly in order) does not trigger it.
- **Bound**: cost is proportional to the retained log of that Space. Control events are **never compacted** (amendment A-6), so the authority fold is always reproducible. Data packets older than the retention window are already folded into a snapshot; a removal that predates the window and arrives after compaction cannot invalidate them. This is an explicit limit: **removals older than the retention window are final** (default 30 days; configurable).
- **Alternatives**: store packets that fail a later check in a "quarantine" and keep a per-field history so a field can fall back to its previous value (a full multi-version store); accept divergence (violates Principle III).

## R-11: Snapshots must be sealed and authenticated

- **Problem found in review of 001**: the sync-protocol `snapshot` message carries `objects` as plain `SyncableObject` state. Over a relay or any transport that is **plaintext**, which breaks Principle V. It is also **unsigned**, so any peer or relay could forge state.
- **Decision** (amendment A-3):
  - Snapshot `objects` are sealed with the payload codec for their scope (Space or override share): one sealed blob per scope per part. Snapshot parts for an override share are sent only to peers that are members of the share (non-members get none; they cannot read it anyway).
  - A snapshot message carries `signer` (device ID) and `sig` (Ed25519 over the canonical message with `sig` null). A new `SnapshotValidator` hook accepts a snapshot only if the signer is currently an Owner or Editor of the Space, and rejects it otherwise.
  - Snapshots never contain `$sys.*` objects (they are not compacted, so a peer always gets them as packets). A forged snapshot therefore cannot change membership or roles.
- **Residual trust**: an Editor can sign a snapshot with wrong field values. An Editor can already write any non-control field, so this is within their authority, except that it may misattribute older values. Accepted for v1 and listed in Risks.
- **Alternatives**: no snapshot bootstrap across trust boundaries (a peer whose gap was compacted away could never catch up); per-field signatures inside snapshots (large, and it needs every original signature kept, which defeats compaction).

## R-12: Override shares

- **Decision**: An override share is a scope with its own member list and keys, bound to **one object ID**. It is created by `$sys.share` `{shareId, obj, members: [{user, role}]}` plus an initial epoch and grants. Packets for that object use the share's key (`scopeId` in the codec header), while `envelope.space` stays the Space ID so routing and storage are unchanged.
  - Binding: the codec resolves `obj → shareId` from the authority state. The create packet for an object in a share is encrypted under the share from the first write.
  - Roles inside a share are independent of Space roles but cannot exceed them: a Space Viewer is at most a share Viewer. A user who is not a Space member cannot be added to a share (members of a share are a subset of Space members).
  - Non-members of the share store and relay its packets (FR-012) and verify the envelope validator (R-05), but cannot decode them.
  - Space Owners who are not in a share cannot read or edit it. The share's own Owner(s) manage it. This is stated plainly in the UI contract: Space Owner power does not reach into private shares.
  - **Removing someone from the Space** removes them from every share and rotates each share they were in.
- **Open point (decided for v1)**: converting an existing object into a shared-with-fewer-people object does not hide prior history from Space members who already decrypted it. It rotates for the future only (consistent with the spec's assumption that rotation protects future data).
- **Alternatives**: per-field sharing (more granular, much more key management); a separate Space per private item (fits the model but loses the "inside Family" experience and needs the object to move Spaces, which 001 does not allow).

## R-13: Identity Provider contract (FR-013) and what stays in the framework

- **Decision**: The framework always owns **signing, encryption, authority and rotation**. A provider owns only **who someone is and how people and devices find each other**:

  | Provider responsibility | Framework responsibility |
  |---|---|
  | Create a user and its first device; supply the user ID | Generate and store device keys, sign, verify |
  | Prove a device belongs to a user (`DeviceBinding` evidence) and verify that proof (pure function, used inside validators) | Decide membership and roles from signed control events |
  | Create invites and carry them out of band (link, QR) | Check expiry and use limits in the authority fold |
  | Run the join handshake between inviter and joiner | Write the member event, rotate and grant keys |
  | Run the device-link handshake | Write the device binding event |
  | Revoke a device (provider-side side effects) | Cutoff, rotation |

  The contract is [contracts/identity-provider.ts](./contracts/identity-provider.ts). The contract test suite (`identityProviderContract()` in `@sync/testkit`) runs against the default provider and against a **stub provider** (SC-005).
- **Binding evidence is opaque to the framework**: `DeviceBinding.proof` is bytes plus a `kind` string, and `verifyBinding()` is a **synchronous, pure** function so it can run inside a validator without I/O. The default provider's evidence is a signature by an already-bound device of the same user (peer chain). An organization-login provider could instead return a token signed by the organization's key.
- **Alternatives**: provider supplies the signing keys (then the provider can forge; also breaks the "framework owns crypto" rule); provider has full control of membership (spreads the role rules across implementations and breaks SC-001).

## R-14: Default provider: invite links, QR, and the join handshake

- **Decision**: An **Invite** is `{inviteId, space, role, expiresAt, maxUses, secret (256-bit), inviter: {deviceId, signPub, agreePub}, approval: 'required'|'auto'}` encoded as a URL fragment (`#/join/<base64url>`), so it is never sent to a static host. The same string is rendered as a QR code.
  - **Registration**: the creating Owner writes a `$sys.invite` event containing `inviteId`, `role`, `expiresAt`, `maxUses` and `SHA-256(secret)` (never the secret). All peers can then check expiry, role and use counts.
  - **Handshake** (details in [contracts/join-protocol.md](./contracts/join-protocol.md)): the joiner generates device keys, then sends a `join-request` containing its public keys, `inviteId`, and `HMAC(secret, joinerSignPub || nonce)` as proof of possession, encrypted to the inviter's X25519 key. An Owner device checks the invite (exists, not expired, uses left), asks the user to approve if `approval = 'required'`, then writes the `$sys.member` event (with a device binding for the joiner), rotates if needed, and returns a **join grant** (wrapped epoch keys, the control history cursor, the current member list) as a `join-grant` message.
  - **Transports for the handshake**: online, through the relay (it forwards the opaque messages, see A-4); offline, through a **WebRTC data channel** paired by QR/code (spec 001 R-01), on a shared LAN. This changes the spec's Assumption "offline joining over Bluetooth": Web Bluetooth cannot connect two browsers (001 R-01), so offline join means **local network + WebRTC manual signaling** for every browser, not just Chromium. See the follow-up note in the plan.
  - **Shortcut for two people in the same room**: the QR the Owner shows can embed the WebRTC offer **and** the invite in one code when it fits; otherwise it is a two-step exchange (invite QR, then answer QR). SC-004 (< 60 s) is tested with the two-step exchange as the worst case.
  - **Photographed QR** (Edge Case): approval is `required` by default, the approval screen shows the joiner's device name and a **short authentication string** (first 5 bytes of the joiner key hash as a word list), and use limit and expiry are mandatory. A leaked single-use invite can be used once, and only if the Owner approves. Revoking the invite (`$sys.invite-revoke`) works at any time.
  - **Two people accept the same single-use invite at once** (Edge Case): two Owner devices (or one, racing) may both grant. The authority fold counts uses in clock order: the first `maxUses` member events take effect, the rest are **inert** and any Owner that sees an inert join triggers a rotation to exclude the surplus device.
- **QR rendering**: `qrcode-generator` (MIT, ~20 KB, no dependencies) in `identity-invite` only. Scanning uses the platform `BarcodeDetector` when present; otherwise the app shows the invite as a link/code to paste, and the camera app of the phone can open the link. No scanning library is shipped in v1. Justified in the plan's dependency table.
- **Alternatives**: invite secret used directly as a bearer capability for the Space key (anyone with the QR gets the key without Owner involvement; no approval, no per-use count); an invite signed token with no Owner interaction (cannot deliver keys, because keys must be wrapped to the joiner by a key holder, so an Owner or Editor device must be online anyway).
- **Who can grant keys**: any active device of an Owner. If no Owner is reachable, the joiner waits (nothing to do offline without a key holder).

## R-15: Linking another device of the same user (User Story 4)

- **Decision**: the new device generates keys and shows a **link code** (QR) containing its public keys. An already-bound device of that user scans it (or the reverse; either direction works) and writes `$sys.device` events for the new device into **every Space of that user**, signed by itself (a user may always write bindings for their own devices, regardless of role). It then grants every epoch key the user is entitled to, for every Space and share the user is in. The new device's packets are attributed to the same `userId` through the binding.
- **Revocation** (Story 4 scenario 3): any bound device of the user can write a `$sys.device-revoke` with a cutoff. The framework rotates keys of every Space and share the user was in, because the lost device holds them. Every bound device is equal (no primary device). A stolen *unlocked* device can revoke the others; this is accepted and mentioned in Risks.
- **Lost device and no other device** (Edge Case): any **Space Owner** can remove the whole user (not only the device), then re-invite the person. Without an Owner or another device there is no recovery (spec: out of scope).
- **Alternatives**: a user master key that signs device certs (a single secret to lose or protect, which is exactly the recovery problem the spec put out of scope).

## R-16: Storage of control and key data

- **Decision**: Control events live in the existing `packets` and `objects` stores like any object. Keys live in the separate `sync-keys` IndexedDB database (R-03). Two small local-only stores in `sync-keys`: `authority-cache` (computed fold per Space plus the clock it is computed to) and `key-index` (`scope:epoch:keyId` → wrapped key). Both are rebuildable from the log and grants, so a corrupt cache is repaired by a rebuild.
- **Rationale**: no change to the `StorageAdapter` contract (001 is done). The key database is separate so that sync, snapshots and the export features never see it.

## R-17: Testing approach (Principle VIII)

- **Contract suite**: `identityProviderContract()` in `@sync/testkit` (SC-005).
- **Adversarial suite** (SC-001): fast-check generates packet streams with a mix of forged signatures, non-members, Viewers writing, revoked devices, backdated clocks, tampered headers and replays; the oracle is "none of the invalid ones is applied on any peer, and all valid ones converge".
- **Order-independence** of the authority fold: fast-check shuffles control events and delivery order across 3 to 5 peers; the state hash and the authority state hash must match (extends 001's SC-004 property).
- **Plaintext scan** (SC-002): the relay server test writes marker strings into field values and object types, syncs through the relay and greps its in-memory and persisted state, including snapshot messages.
- **Removal test** (SC-003): a removed device syncs after rotation and must fail to decrypt 100% of new packets.
- **Real browsers**: Playwright runs the join handshake and device link with two Chromium contexts using WebRTC loopback (offline join), and relay-mediated join.
- **Known-answer tests** for the codec and grant format, so another implementation can be checked.

## R-18: Performance and scale decisions

- **Targets**: a Space with up to 100 member devices; at most 10,000 control events retained; rotation for 100 devices completes in under 2 s on a mid-range phone profile (4x CPU slowdown, from 001 reference profile); Ed25519 verify throughput supports 2,000 packets/s on that profile. Sync of 10,000 packets must not slow by more than 30% against plaintext (benchmarked in T-bench).
- **Techniques**: verified-signature cache keyed by packet ID (a packet is verified once, then the verdict is remembered; the cache is rebuilt, not trusted from disk); authority state cached and recomputed incrementally from the earliest changed clock; verification is batched and uses `crypto.subtle` asynchronously so the main thread is not blocked (001 constraint).
- **Beyond 100 devices** is out of scope; the O(n) grants per rotation is the known limit (R-09 alternatives names MLS as the later path).
