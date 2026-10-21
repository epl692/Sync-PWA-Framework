# Security Review: Spaces, Security & Identity

Task T090. Scope: `packages/spaces`, `packages/identity-invite`, the core amendments, and the test-kit pieces that stand in for them. Method: read every path that handles keys, invites, signatures, the authority state or a peer-supplied message with an attacker's eye, then try the attacks that survived reading (`packages/spaces/tests/adversarial/`), and stress-test with randomized hostile streams in parallel runs.

## Findings fixed

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | A device-link code (QR or text) was enough to receive every key of the user: anyone who saw it within 10 minutes could link a device, through a relay | `approveLink` is required and **defaults to refusing**; both devices show the same five-word code; the code is single use; a refusal reaches the new device at once | `link-device.test.ts` (declined link) |
| 2 | A provider could ask the device to sign arbitrary bytes, which would let it forge packets | `LocalDevice.sign` signs only messages starting `sync-binding/` (packet signing inputs are JSON) and exposes no key | `provider-sandbox.test.ts` |
| 3 | Invite secrets sat unwrapped in the key database | Wrapped with the device wrapping key like epoch keys | `keystore.test.ts` |
| 4 | Two copies of one join request racing could both pass the replay check | Check and remember with no `await` between | contract suite: replay and tamper check |
| 5 | Ordinary writes made while this device was rotating a scope used the old key, which the removed member still holds | Ordinary writes in a scope wait for the new key while a local rotation runs | `override-share.test.ts` (removal) |
| 6 | Two Owners removing each other while apart never converged: each side rejected the other's removal because, in its own view, the other Owner was already removed | Signature-valid control events from known devices are accepted and the fold decides (inert if not allowed) | `inert-notify.test.ts`, adversarial streams |
| 7 | Rotation by an Owner who had not seen another Owner's removal counted as covering it when clocks happened to order that way, leaving a removed member with the key | Epochs record the removals they cover; a scope is rotated until its current epoch covers every shrinking event | `rotation.test.ts`, `authority.test.ts` |
| 8 | After a rebuild or a restart the rebuild triggers did not know which packets had been applied, so a removal arriving later missed a removed member's late packets | Per-author applied stats are read from the log on load; events that arrive during a reload are re-checked | adversarial streams (found by 300-run stress), `retroactive-rebuild.test.ts` |
| 9 | The genesis packet failed its own standing check when replayed during a rebuild, which orphaned the whole Space | The Space's own genesis packet is exempt, as it is when first applied | `validators.test.ts` |
| 10 | A snapshot is state, unsigned and in the clear in 001 | Sealed with the Space key and signed by a current Owner or Editor; plain snapshots are refused when a guard is installed | `snapshot-sealed.test.ts`, `e2e-relay.test.ts` |

## Checked and sound

- **Invite proof** is an HMAC over the joiner's key and a fresh nonce, compared in constant time; the secret never leaves the artifact and the creating device; the Space log holds only its SHA-256.
- **Sealed handshakes** use an ephemeral key per message and a context bound as authenticated data (a reply cannot be replayed as a request); only the addressed device can open a message; every failure is silent.
- **Signatures** cover the received envelope bytes with `sig` nulled, so unknown extra fields stay covered; a key must hash to the author's device ID; verdicts are cached by packet ID and signature.
- **Nonces**: random 96-bit under one key; use is counted and the scope rotates at 2^31.
- **Authority**: control events are create-only; a Space ID is bound to the creating key, so no one else can author a valid genesis for it; devices per user, invite lifetime and role caps are enforced in the fold.
- **Override shares**: a packet for a shared object must use the share's key after the share exists; Space Owners outside a share cannot read or write it; share-bound packets are pinned out of snapshots.
- **Keys at rest**: device private keys non-extractable; epoch keys and invite secrets wrapped; the key database is never synced, snapshotted or exported.

## Accepted risks (each is documented where it arises)

| Risk | Why it is accepted | Mitigation |
|---|---|---|
| Script running in the page can use the keystore (sign, decrypt) | The platform offers nothing better; non-extractable keys prevent theft of the key itself | Modules receive the Spaces API only, never the keystore (spec 003 module host) |
| An Editor can sign a snapshot with wrong field values | An Editor can already write any non-control field; control events and shares are never in snapshots | Documented in research R-11 |
| A removed device can release packets it withheld, if their sequence numbers are at or below the cutoff and their clock is before the removal | Indistinguishable from slow honest delivery; bounded by what it really authored | Research R-08 |
| Deferred packets (unknown author) are stored and relayed | A peer that has not learned the device yet must still pass legitimate packets on | `maxParkedPerAuthor` bounds what one author can park on each receiver |
| No rate limit on identity-channel messages: each costs up to four trial decryptions | Messages are size-limited by the transports; a limit belongs with the app and the relay | Relay-side rate limiting is recommended for public relays |
| Only the device that created an invite can answer it | Keeps the secret on one device | The Owner re-issues an invite from a device that is online |
| Binding chains stay valid after a device in the chain is revoked | Standing in a Space comes from the revocation records, not from the chain | Revocation rejects the device's packets and rotates keys |
| Share IDs, recipient device IDs of grants, packet sizes and timing are visible to a relay | Minimum routing metadata (FR-006) | Listed in the spec and in research R-04 |
| A removed member keeps everything it already decrypted | Spec assumption | Rotation protects future data only |
| A key grant sent just before an Owner learns of a removal reaches the removed device | Offline Owners cannot know | The Owner rotates again on learning; epochs cover the removal (finding 7) |
| Account recovery is out of scope | Spec | An Owner removes the user and re-invites the person |

## Not in scope

Transport-level attacks that need no key (traffic analysis, denial of service on the relay), the module sandbox (spec 003), blob encryption (spec 004), and the browser's own storage security.
