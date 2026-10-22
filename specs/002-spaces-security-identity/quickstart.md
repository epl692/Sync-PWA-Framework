# Quickstart: Validating Spaces, Security & Identity

Runnable scenarios that prove the feature end to end. Interfaces: [contracts/](./contracts/). Entities: [data-model.md](./data-model.md). Layout: [plan.md](./plan.md). Prerequisite: spec 001 is built. Recorded results: [validation.md](./validation.md).

## Prerequisites

- Node 20+, npm 10+ (Web Crypto Ed25519 and X25519 are available)
- Chromium for the browser scenarios (`npx playwright install chromium`). In a sandbox where that is not possible, point `PW_CHROMIUM_PATH` at an installed Chromium
- Manual check S9 only: two devices on one local network

```bash
npm install
npm run typecheck
```

All commands run from the repository root.

## S0. Core amendments in place (gate for everything below)

```bash
npx vitest run packages/core
```

**Expect**: the amendment tests pass (signer fills `sig`, rebuild, sealed snapshots, channel, hidden and pinned types, parked limit, applied/held/scan) and the whole 001 suite still passes unchanged.

## S1. Encrypted Space, relay sees no plaintext (Story 1, SC-002)

```bash
npx vitest run packages/spaces/tests/integration/create-space.test.ts packages/spaces/tests/integration/e2e-relay.test.ts packages/spaces/tests/unit/unsupported.test.ts
```

**Expect**: the creator is Owner with an epoch-0 key; everything the relay stores or forwards (packets, snapshots, channel traffic) contains none of the plaintext markers written into types, field names and values; where Ed25519 or X25519 is missing nothing is created and nothing falls back to plaintext.

## S2. Peers enforce roles (Story 2, SC-001)

```bash
npm run test:adversarial
CONVERGENCE_RUNS=300 npx vitest run packages/spaces/tests/adversarial/adversarial.test.ts     # a longer randomized run
```

**Expect**: forged signature, non-member, Viewer write, revoked author, backdated clock beyond a cutoff, tampered header and envelope, moved ciphertext, replay: none applied on any peer, none relayed; valid packets converge. Use `CONVERGENCE_RUNS=10000` for the release run.

## S3. Invite by link, online (Story 3)

```bash
npx vitest run packages/identity-invite/tests/integration/join.test.ts
npx playwright test invite-online
```

**Expect**: an Owner creates an invite (expiry, use limit, approval); a second node accepts through the relay, receives the Space's history and can write per its role; a second use of a single-use invite and an expired, revoked or unknown invite are refused.

## S4. Invite by QR, no internet (Story 3, SC-004)

```bash
npx playwright test invite-offline-webrtc
```

**Expect**: two Chromium contexts pair by WebRTC codes, the network goes offline, and the invite is accepted in under 60 s (about 4 s measured). The joiner reads the data; as a Viewer its writes are refused.

## S5. Link another device, revoke a lost one (Story 4)

```bash
npx vitest run packages/identity-invite/tests/integration/link-device.test.ts packages/spaces/tests/integration/revoke-device.test.ts packages/spaces/tests/unit/device-limits.test.ts
```

**Expect**: the new device has its own key, receives every Space and share of the user and all history, and its packets are attributed to the same user. Revoking it from the first device rejects its later packets and rotates keys. A declined link links nothing.

## S6. Remove a member (Story 5, SC-003)

```bash
npx vitest run packages/spaces/tests/integration/remove-member.test.ts packages/spaces/tests/unit/cutoff.test.ts packages/spaces/tests/integration/retroactive-rebuild.test.ts
```

**Expect**: after removal, 100% of packets written afterward are undecryptable on the removed device; the last Owner cannot leave or be demoted; packets beyond the cutoff are rejected; a peer that applied a removed member's late packets rebuilds and converges when the removal arrives.

## S7. Private object inside a Space (Story 6)

```bash
npx vitest run packages/spaces/tests/integration/override-share.test.ts packages/spaces/tests/integration/share-snapshot.test.ts
```

**Expect**: a Space member outside the share stores and relays the object's packets but cannot read them; Space Owners outside the share cannot read or edit it; share roles are enforced and capped for Space Viewers; removing someone from the Space removes them from every share and rotates its key.

## S8. Swap the Identity Provider (Story 7, SC-005)

```bash
npx vitest run packages/testkit packages/identity-invite/tests/contract packages/identity-invite/tests/integration/provider-swap.test.ts
```

**Expect**: the contract suite passes for the default `invite-qr` provider and the stub provider, fails deliberately broken providers, and the same Spaces scenario passes under both providers with no other code changed.

## S9. Manual check (two real devices)

1. Device A: create a Space, create an invite, show the QR.
2. Device B (same Wi-Fi, no internet): scan the QR, exchange the pairing codes, approve on A.
3. Confirm the five-word codes match on both screens; B appears as a member; edit on either side; remove B and confirm B can no longer read new edits.

## S10. Edge cases (spec Edge Cases)

```bash
npx vitest run packages/spaces/tests/integration/edge-cases.test.ts packages/spaces/tests/integration/inert-notify.test.ts packages/spaces/tests/integration/rotation.test.ts packages/identity-invite/tests/integration/invite-race.test.ts packages/identity-invite/tests/integration/photographed-invite.test.ts
```

**Expect**: concurrent mutual removal ends with exactly one Owner on every peer and only the loser is told; a simultaneous single-use invite admits one, and a surplus admission by another Owner device is inert and rotates the key; a member offline across several rotations decrypts everything after catching up; a copied invite shows the Owner a different five-word code and can be declined; a lost device with no other device is handled by an Owner removing the user.

## S11. Performance

```bash
npx vitest run packages/spaces/tests/perf        # prints the measured numbers
npx vitest bench --run packages/spaces           # crypto micro-benchmarks
```

**Expect** (measured here, then scaled by the 4x phone profile): rotation for 100 devices < 2 s; signature verification ≥ 2,000 packets/s; ingest of encrypted packets above 300/s (research R-18).

## S12. Everything

```bash
npm test                                   # all unit, contract, integration and property tests
npx playwright test                        # all browser tests
```
