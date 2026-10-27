# Security review: Blob Sync (004)

Scope: what this feature adds to the threat surface of the framework, what it relies on from 001 to 003, and what it does
not defend against. Findings are tied to tests. Written against the implementation, not the plan.

## What is protected, and by what

| Property | Mechanism | Evidence |
|---|---|---|
| Blob bytes never leave a device in plaintext (FR-002, Principle V) | `attach` encrypts every chunk before it is stored; only ciphertext is ever stored, offered or served | `relay-plaintext.test.ts` scans every byte through the relay and every file it wrote for a known marker |
| A relay or peer cannot substitute data | The blob ID is the SHA-256 of a manifest of per-chunk digests; the reference that carries the ID lives in a signed, role-checked packet. Receivers check manifest hash, each chunk digest, and the AES-GCM tag (AAD binds scope, key ID, size, chunk size, index) | `tamper.test.ts`, `tamper.property.test.ts` (1000 generated bit flips: none stored or yielded), `verify.test.ts` |
| Override-share blobs are unreadable outside the share (FR-002, edge case) | The key is derived from the share's epoch key; `keys.test.ts` shows a Space member outside the share fetches only ciphertext and `open` fails with `no-key` | `keys.test.ts` |
| A removed member cannot read blobs of later epochs | Rotation gives the removed device no new epoch key; blobs name the epoch (`keyId`) | `keys.test.ts` |
| A relay holds no keys | `@sync/relay-server` does not import `@sync/spaces` (guard test); `BlobRelay` verifies structure only | `release-surface.test.ts` |

## Deterministic nonces

Chunk `i` is encrypted under `nonce = HMAC-SHA-256(macKey, "n" ‖ i ‖ SHA-256(plaintext chunk))[0..96 bits]` with
`encKey`, `macKey` derived from the scope's epoch key by HKDF. This is what makes identical content in one scope and
epoch produce one blob ID (dedup, FR-007) and lets a relay verify an upload without any key.

- **Why it is safe.** AES-GCM is catastrophically broken only when one key and nonce encrypt two *different* plaintexts. Here
  a repeated `(key, nonce)` implies a repeated `(index, plaintext chunk)` (up to a 2⁻⁹⁶ HMAC collision), which yields the
  same ciphertext and reveals nothing new. Keys are per scope and epoch, so another Space or another epoch never shares a nonce space.
- **Budget.** Collisions between *different* chunks need about 2⁴⁸ chunks under one key (birthday bound on 96 bits), about
  64 EiB at 256 KiB each: not reachable.
- **Tests.** The property test in `crypto.test.ts` generates chunks and indexes and asserts a nonce never repeats for different
  content; known-answer vectors (`tests/vectors/`) were produced by an independent script with Node `crypto`.

## Accepted leaks and risks

1. **Equality inside a scope and epoch.** Two blobs that share an identical chunk at the same index have identical
   ciphertext for it, and the same file twice has one ID. A relay (and any member) can see that. Across Spaces and across
   epochs IDs differ. Members can read everything in the scope anyway.
2. **Sizes and scope IDs are visible to a relay.** The manifest carries `size`, the raw scope ID and the key ID in clear
   (already visible in packet headers, spec 002). Not hidden.
3. **Junk against a relay's quota.** A relay cannot verify AES-GCM tags (it has no key), so anyone who can connect and
   declare a Space can store structurally valid garbage in that Space's quota. Bounded by `perSpaceBytes`, `totalBytes`, the
   idle TTL (a cache: junk is evicted) and the optional `authorize` hook. Real authentication of who may upload belongs to
   the relay operator, as it does for packets.
4. **Moving an object into a share does not re-encrypt an earlier attachment** (parity with earlier packets). Documented in
   `docs/blobs.md`.
5. **`request` and `offer` reveal interest to a peer.** A peer learns which blob IDs a device asks for. IDs are keyed
   hashes, so they say nothing about content without the key.

## Abuse and availability

- **Floods.** A peer is limited to 64 `offer` messages per second (excess dropped) and 256 pending requested ranges
  (excess answered `reject {busy}`); a requester coalesces to stay under that. A `get` range is clamped to the blob's
  chunk count, so a huge upper bound answers with one `miss` instead of a loop. Tests: `flood.test.ts`.
- **Memory.** Attach reads one chunk at a time; open decrypts one chunk at a time; the serve loop sends one chunk message at
  a time and yields. Measured: 7.9 MiB above baseline for a 32 MB fetch (`budgets.perf.test.ts`).
- **Strikes.** A peer that fails verification three times for a blob is not asked again for it that session; a manifest
  that does not hash to the ID is never stored; chunks are written only after their digest matches.
- **Late or duplicate messages** are ignored (a chunk is accepted only if it was asked for and is not already held).
- **Retained data.** A blob nothing references is deleted (30 days after the last reference went, 24 hours if it never had
  one); eviction never touches the only known copy, pinned or open blobs.

## Key handling surface

Raw epoch keys never leave `@sync/spaces`. It derives per-scope blob keys (`blobKeys.forWrite/forRead`) as non-extractable
`CryptoKey`s; `@sync/blobs` touches them only in `src/crypto/keys.ts` (a lint rule enforces that no other file imports
`@sync/spaces` values). The packet codec's use counter (002 R-04) is unaffected because blob nonces are deterministic.

## What a removed member can and cannot do

Can: read what they already downloaded under epochs they hold; fetch ciphertext of newer blobs from a relay or a peer that
still syncs the Space; see sizes and IDs. Cannot: decrypt a blob encrypted under an epoch key they were never granted
(`failed / no-key`), forge a reference (references live in signed packets), or make a peer accept altered bytes.

## Open items

- Pins, budgets and replica beliefs are device-local and not authenticated; they are not part of any trust decision.
- A hostile same-origin module is out of scope for access declarations (spec 003 R-10), including `ctx.blobs`.
- No rate limiting is applied to a relay's `get` beyond the per-peer pending-range cap; a deployment that needs more
  should front the relay with a connection limiter.
