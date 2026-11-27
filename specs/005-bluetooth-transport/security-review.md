# Security review: Bluetooth Local Transport (005)

Scope: what the Bluetooth transport and the Hub add to the framework's threat surface, what they rely on from specs 001 to 004,
and what they do not defend against. Written against the implementation. Every claim names the test that covers it. Native code
(Android plugin, desktop sidecars) is **not** covered here because it has not been written or run on hardware; see "Not reviewed".

## What is protected, and by what

| Property | Mechanism | Evidence |
|---|---|---|
| The Hub holds no content key (FR-011, SC-004, Principle V) | `@sync/hub-core` never imports `@sync/spaces` (lint rule and guard test); it stores packets as received bytes; membership is verified with a derived Ed25519 *public* key | `release-surface.test.ts` (hub-core), `access/verify.test.ts`, `access/not-served.test.ts` ("what the Hub stores is exactly the bytes it was sent") |
| A Hub can verify membership but cannot decrypt (FR-016) | Access key = `HKDF(epochKey, "sync-hub-access/1"‖space‖epoch)`; one-way and domain-separated from every other derived key | `packages/spaces/tests/unit/hub-access.test.ts` (known-answer vectors computed independently with Python `cryptography`, and a property test that no other label's key collides and none of it equals the epoch key) |
| Radio eavesdroppers see no envelope metadata (R-06) | X25519 handshake, Hub-signed transcript, AES-256-GCM per message with per-stream counters | `link/handshake.test.ts` (known-answer vectors, replay, tamper, wrong key), `property/loss.property.test.ts` (no corrupt message ever authenticates) |
| A Hub cannot be impersonated to a client that trusted it (RK-7) | The client pins the Hub's public key on first use; a different key under a pinned fingerprint aborts with `hub-identity-changed` before any proof is sent | `trust.test.ts` ("a Hub that claims a pinned fingerprint with a different key is refused") |
| A stranger learns nothing about what a Hub serves (FR-014) | INFO has only name, fingerprint, mode, slots, version; unknown Space and bad proof get the identical `reject not-served` | `access/not-served.test.ts` |
| A captured membership proof cannot be replayed (spec edge case) | The proof is bound to the Hub fingerprint, both session nonces, the Space and the epoch | `adversarial/link.test.ts` ("a proof captured in one session fails in another"; wrong epoch; tampered nonce) |
| A device cannot claim another device's identity | The device ID must be the hash of the key that signs the session binding; a mismatch is a strike, never a login | `adversarial/link.test.ts` ("a device proof that does not match the device ID") |
| The owner controls access (FR-012, FR-015) | Open mode (default), approval mode, block, unblock, automatic Spaces off by default | `approval.test.ts`, `access/autoSpaces.test.ts` |
| Packets still pass every check on the receiving device (FR-025) | The Hub never applies packets; clients receive them through the normal path that verifies signatures and roles (spec 002) | Unchanged core path; `integration/two-clients.test.ts`, `property/convergence.property.test.ts` |

## Threats considered

| # | Threat | Outcome | Test |
|---|---|---|---|
| 1 | Radio eavesdropper reads packet metadata | Mitigated by link encryption. The advertisement and INFO are readable by design (name, fingerprint, mode, slot count) | handshake tests |
| 2 | Rogue Hub advertises a trusted Hub's fingerprint | Refused: key differs from the pinned one. A rogue Hub with its *own* fingerprint is a new Hub the user must confirm by name, fingerprint and four words | `trust.test.ts` |
| 3 | Nearby stranger connects to a Hub | Rejected without learning which Spaces exist; handshake and authentication limits apply | `not-served.test.ts`, `adversarial/link.test.ts` |
| 4 | Stranger floods handshakes or fills the Hub | 6 authentications per minute per proven device, 30 handshakes per minute overall (answered `busy` cheaply), client slot limit, 20 s unauthenticated lifetime, 3 strikes then block | `adversarial/link.test.ts` (limits, strikes, deadline), `session.test.ts` (busy, slots) |
| 5 | Malformed frames and messages | Dropped; oversize aborts and counts a strike; a missing frame is a loss, not a strike, so a noisy radio never blocks a device | `frames.test.ts`, `property/frames.property.test.ts`, `adversarial/link.test.ts` ("garbage frames never crash the Hub") |
| 6 | Removed member keeps connecting (RK-2) | See "Accepted risks" 1 | `packages/spaces/tests/integration/hub-access.test.ts` shows the removed member has no key for the new epoch |
| 7 | Squatting a Space ID in automatic mode (RK-3) | Bounded: the first valid claim wins, a claim never changes a registered key, 20 automatic Spaces at most, per-Space byte cap, owner can remove | `access/autoSpaces.test.ts` |
| 8 | Strike or block attributed to someone else | Strikes before the device is proven count against the connection only; a claimed device ID is never blocked | `adversarial/link.test.ts` |
| 9 | Data loss through a lossy radio | Detected by sequence gap, ACK timeout and reassembly timeout; both sides restart the sync handshake (acknowledged, retried, closes the link if never acknowledged) | `property/loss.property.test.ts`, `integration/loss-resync.test.ts`, `link/resync.test.ts` |
| 10 | Replay of an encrypted link message | Per-stream strictly increasing counters; replays and out-of-window messages fail to open | `handshake.test.ts` ("each stream has its own counter and replay window") |
| 11 | Packet store corruption or a torn write | Records carry length and CRC; the valid prefix survives, the torn tail is discarded; unknown segment version is refused, not rewritten | `store.segment.test.ts`, `compat.test.ts` |
| 12 | Helper program (sidecar) misbehaves | Lines over 8 KiB, non-JSON, unknown version, silence and crashes all end the bridge cleanly; unknown events are ignored | `bridge.sidecar.test.ts` |

## Accepted risks

1. **A removed member can still pass membership proofs for old epochs (RK-2).** Until the owner imports the new epoch's serve code
   (and the old key expires after the retention period), a removed member can connect and download **ciphertext** of Spaces
   they were in. They cannot read anything from the new epoch (no key). Same data they could already hold. Open item O-1
   tracks automatic renewal.
2. **Open mode lets any member of a served Space connect.** Intended (spec clarification). Approval mode is the control.
3. **Automatic Space mode is trust on first use (RK-3).** A stranger who knows a Space ID (visible to anyone relaying) can register
   first on a Hub that has the mode on and lock real members out *of that Hub*. Off by default, capped, visible and removable.
4. **The link code carries an access secret.** It cannot decrypt content, but whoever holds it can pass membership checks and can
   make a Hub join other Hubs. The UI shows a warning; it is a separate, opt-in export.
5. **Names are untrusted display text.** Hub and device names come from the radio or the client and are escaped in every UI
   (`bluetooth-panel`, `hub-confirm`, `hub-ui` tests assert no markup is interpreted).
6. **Metadata the Hub necessarily sees:** Space IDs, author device IDs, clocks, key epochs and sizes (the same routing metadata as
   any relay), plus the device ID and display name of each connected client.
7. **Hub packets are evicted by age and pressure.** An undelivered packet can be lost if the owner leaves the Hub full; the owner is
   warned first (`retention.test.ts`).
8. **Timing and size side channels** on the radio are not hidden (frame sizes, burst patterns).
9. **Hub key storage.** The Hub's Ed25519 seed is stored through `HubStore.saveHubKey`. The reference stores write it unencrypted;
   the plan calls for the platform keystore in the native shells, which does not exist yet. A thief with the Hub device's files can
   impersonate the Hub to clients that pinned it (not read content).

## Not reviewed (not built or not runnable here)

- The Android plugin (Kotlin), the Windows and macOS sidecars, and the Linux BlueZ bridge. Their contract (`BleBridge`, the sidecar
  protocol) is tested against simulators only. Platform behavior (permissions, advertising limits, connection caps, background
  limits) is unverified until the hardware spikes and the device matrix in `quickstart.md` are run.
- Real Web Bluetooth behavior: the write-size limits and `getDevices()` availability are assumptions (spikes S-2 and S-4).
- The 8-hour soak and the battery measurements.

## Key handling surface

- Hub: Ed25519 seed (link identity). Access *public* keys per Space and epoch. For link codes only: access secrets. No Space key, no
  epoch key, no write key, no device key of any client.
- Client: nothing new. The transport receives signatures from `spaces.hubAccess.proofs`, never keys.
- Session keys live in memory only and are dropped on disconnect.
