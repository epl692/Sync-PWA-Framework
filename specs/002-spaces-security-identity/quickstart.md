# Quickstart: Validating Spaces, Security & Identity

Runnable scenarios that prove the feature end to end. Interfaces: [contracts/](./contracts/). Entities: [data-model.md](./data-model.md). Layout: [plan.md](./plan.md). Prerequisite: spec 001 is built.

## Prerequisites

- Node 20+, npm 10+ (Web Crypto Ed25519 and X25519 are available)
- Chromium via Playwright (`npx playwright install chromium`)
- Manual check S9 only: two devices on one local network

```bash
npm install
npm run build
```

## S0. Core amendments in place (gate for everything below)

```bash
npm run test -w @sync/core -- tests/integration/amendments
```

**Expect**: A-1 to A-7 tests pass (signer fills `sig`, rebuild, sealed snapshots, channel, hidden `$` types, pinned compaction), and the full 001 suite still passes unchanged.

## S1. Encrypted Space, relay sees no plaintext (Story 1, SC-002)

```bash
npm run test -w @sync/spaces -- tests/integration/e2e-relay.test.ts
npm run relay-server    # ws://localhost:8787
```

**Expect**: creator is Owner with an epoch-0 key; the relay's stored and in-flight data (packets, snapshots, channel traffic) contains none of the plaintext markers written into types, field names and values.

## S2. Peers enforce roles (Story 2, SC-001)

```bash
npm run test -w @sync/spaces -- tests/adversarial
```

**Expect**: forged signature, non-member, Viewer write, revoked author, backdated clock beyond cutoff, tampered header, replayed packet: none applied on any peer, none relayed; valid packets converge. Runs ≥ 10,000 randomized scenarios.

## S3. Invite by link, online (Story 3)

```bash
npm run e2e -- invite-online
```

**Expect**: Owner creates an editor invite (expiry, 1 use); second browser accepts through the relay after approval; it decrypts existing data and can write; a second acceptance of the same invite is denied; an expired invite is denied.

## S4. Invite by QR, no internet (Story 3, SC-004)

```bash
npm run e2e -- invite-offline-webrtc
```

**Expect**: two Chromium contexts with the network blocked, joined by the WebRTC manual-signaling flow, complete invite acceptance in under 60 s (timed in the test). The joiner can decrypt and write per role.

## S5. Link another device (Story 4)

```bash
npm run test -w @sync/identity-invite -- tests/integration/link-device.test.ts
```

**Expect**: the new device has its own key, receives all the user's Spaces, and its packets are attributed to the same user. Revoking it from the first device rejects its later packets and rotates keys (new epoch visible).

## S6. Remove a member (Story 5, SC-003)

```bash
npm run test -w @sync/spaces -- tests/integration/remove-member.test.ts
```

**Expect**: after removal, 100% of new packets are undecryptable on the removed device; the last-Owner rule refuses leave/demote; the removed member's packets with `seq` above the cutoff are rejected.

## S7. Private object inside a Space (Story 6)

```bash
npm run test -w @sync/spaces -- tests/integration/override-share.test.ts
```

**Expect**: a Space member outside the share stores and relays the object's packets but gets `missing-key` and sees nothing; share members read and write per their share role.

## S8. Swap the Identity Provider (Story 7, SC-005)

```bash
npm run test:contract -- identityProvider
```

**Expect**: the contract suite passes for the default `invite-qr` provider and for the stub provider; Spaces, signing and encryption tests run unchanged against the stub.

## S9. Manual check (two real devices)

1. Device A: create a Space, create an invite, show the QR.
2. Device B (same Wi-Fi, no internet): scan the QR, exchange the answer code, approve on A.
3. Confirm the short authentication strings match on both screens; B appears as a member; edit on either side; remove B and confirm B can no longer read new edits.

## S10. Edge cases (spec Edge Cases)

```bash
npm run test -w @sync/spaces -- tests/integration/edge-cases.test.ts
```

**Expect**: concurrent mutual removal ends with exactly one Owner on every peer; simultaneous single-use invite accept admits one and neutralizes the other (with rotation); revoked device with a pre-revocation clock but `seq` above cutoff is rejected; a member offline across several rotations decrypts everything after catching up on grants; a lost device with no other device is recoverable only by an Owner removing and re-inviting the user.

## S11. Performance

```bash
npm run bench -w @sync/spaces
```

**Expect** (001 reference profile): rotation for 100 devices < 2 s; 10,000-packet sync ≤ 30% slower than the plaintext codec; signature verification ≥ 2,000 packets/s.
