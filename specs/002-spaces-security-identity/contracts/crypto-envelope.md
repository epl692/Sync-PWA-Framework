# Contract: Encrypted & Signed Packet Format (`aes-gcm-space/1`, `ed25519/1`)

Builds on [../../001-sync-core/contracts/packet-envelope.md](../../001-sync-core/contracts/packet-envelope.md). **The envelope shape does not change.** `codec` is `aes-gcm-space/1` (or `grant/1`), `body` is the codec output below, `sig` is filled.

## Body bytes (`codec = aes-gcm-space/1`)

```
offset  size  field
0       1     fmt        = 0x01
1       16    scopeId    Space ID or override share ID (raw 128 bit)
17      4     epoch      uint32 big endian
21      8     keyId      first 8 bytes of SHA-256(epoch key)
29      12    nonce      random
41      n     ciphertext AES-256-GCM, 16-byte tag appended
```

- Plaintext is the canonical JSON of `PacketBody` (001).
- **AAD** = canonical JSON of `{v, id, author, seq, space, clock, codec}` (UTF-8), followed by bytes 0..28 of the body (header up to `keyId`).
- The header (bytes 0..28) is readable by relays. It is covered by the signature (the whole envelope is) and by the AAD.

## Key grant (a `$sys.keygrant` control object)

A grant is an ordinary create-only control object, **encrypted like every other packet** with the scope's current write key (which, during a rotation, is still the previous epoch; see research R-09). Its fields:

```json
{ "to": "<deviceId>", "scope": "<scopeId>", "eph": "<base64url X25519 ephemeral public key>",
  "items": [ { "epoch": 4, "keyId": "<hex8>", "nonce": "<base64url 12 B>", "wrapped": "<base64url AES-GCM(epochKey)>" } ] }
```

- Wrap key per item = `HKDF-SHA-256(ECDH(eph, recipientAgreePub), salt = 0x00*32, info = "sync-grant/1" || scopeId(16 B) || epoch(4 B BE) || recipientDeviceId)`.
- AAD per item = `recipientDeviceId || scopeId(16 B) || epoch(4 B BE) || keyId(8 B)`.
- A recipient accepts an item only if `SHA-256(unwrapped key)[0..8]` equals `keyId`.
- A join or link grant (delivered over the identity channel, not the log) carries one item per epoch the device is entitled to, which is every epoch of the scope.

## Signature

- `sig = Ed25519(authorSignKey, canonical(envelope with sig = null))`. 64 bytes.
- The author's public key is found from the authority state by `author` (device ID). `deviceId = base32(SHA-256(signPub))[0..128 bits]`, so a key that does not hash to the ID is rejected.
- A packet whose public key is not yet known is **deferred** (`validator-deferred`), not rejected.

## Verification order (receiving side)

1. Dedup by ID (core, before everything).
2. Envelope validator: `sig` present and valid → author device active in Space (or inside its cutoff) → role can write (Owner/Editor) or the object is a self-service type (`$sys.device` for own user).
3. Decode with the codec (picks the key by `keyId`; `missing-key` parks the packet).
4. Body validator: operation allowed for the author's role in the **scope** (Space or share); `$sys.*` types only as the authority rules allow.
5. Apply (core).

Any `reject` stops the chain, the packet is not applied and **not relayed**.

## Compatibility

Required by the constitution for changes touching signing and encryption.

| Situation | Required behavior |
|---|---|
| Codec header `fmt` greater than supported | Park (`undecodable-codec`), store, relay, retry after upgrade |
| Unknown signature algorithm marker in a future `sig` encoding | The 001 `sig` field is bytes. `ed25519/1` signatures are exactly 64 bytes. Another length means a future suite: treat as unknown, **defer** (do not reject, do not apply) and relay |
| Unknown `$sys.*` type | Not applied to the authority fold; kept and relayed. Authority state is unchanged by what an older peer cannot understand |
| Older peer without the spaces package (plaintext test codec) | Out of scope for release builds: the plaintext codec is not exported from the release entry point (001 plan), and `assertSecureCore()` fails a core that has any other codec |
| Changing header layout, AAD, wrap derivation or canonical signing input | MAJOR: new `fmt` / codec ID (`aes-gcm-space/2`), a migration note here, and both codecs registered during a transition |

Rationale: a peer that cannot verify something must keep and forward it but never apply it. An unverifiable packet can never take effect, and nothing is lost for the day the peer upgrades.

## Known-answer vectors

`packages/spaces/tests/vectors/` holds fixed keys, nonces and expected bytes for the codec, a grant and a signature. Another implementation passes when it reproduces them.
