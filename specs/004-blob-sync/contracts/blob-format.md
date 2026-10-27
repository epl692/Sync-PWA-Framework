# Contract: Blob Format & Encryption (`blob-aes-gcm/1`)

Compatibility note required by the constitution (this adds an encryption format): see [Compatibility](#compatibility).

All integers are big endian. `||` is concatenation. `H` = SHA-256. Constants: `CHUNK = 262144` (256 KiB, fixed in `fmt 1`).

## Keys

For a scope `S` (Space or override share) and epoch key `K` (32 bytes, 002), the keystore derives (spaces amendment S-1):

```
okm      = HKDF-SHA-256(ikm = K, salt = 0x00*32, info = "sync-blob/1" || scopeId(16) || keyId(8), L = 64)
encKey   = okm[0..32]   AES-256-GCM
macKey   = okm[32..64]  HMAC-SHA-256
```

The packet codec's use counter (002 R-04) is **not** affected: blob keys are separate derived keys and nonces are deterministic (below).

## Chunking and encryption

`n = ceil(size / CHUNK)`. Plaintext chunk `i` has `len_i = CHUNK` except the last (`size − (n−1)·CHUNK`).

```
pd_i    = H(plain_i)
nonce_i = HMAC-SHA-256(macKey, "n" || u32(i) || pd_i)[0..12]
aad_i   = 0x01 || scopeId(16) || keyId(8) || u64(size) || u32(CHUNK) || u32(i)
ct_i    = AES-256-GCM(encKey, nonce_i, plain_i, aad_i)         // len_i + 16 bytes, tag appended
d_i     = H(ct_i)
```

`nonce_i` is stored **with** the chunk: the stored/transferred chunk is `nonce_i(12) || ct_i`, so a receiver never needs the plaintext to decrypt. `d_i` is computed over that whole stored form `nonce_i || ct_i`.

Same `(K, i, plain_i)` ⇒ same `nonce_i`, `ct_i`, `d_i`. A repeated nonce under one key therefore always repeats the same plaintext, so it leaks nothing but equality (see research R-02).

## Manifest

```
offset  size   field
0       1      fmt        = 0x01
1       16     scopeId    raw 128-bit Space or share ID
17      8      keyId      first 8 bytes of SHA-256(epoch key) (as in the 002 body header)
25      8      size       plaintext bytes (> 0)
33      4      chunkBytes = 262144
37      4      n          number of chunks = ceil(size / chunkBytes)
41      32·n   d_0 .. d_{n-1}
```

`id = base64url(H(manifest))` (43 characters, unpadded).

A manifest is **well-formed** only if: `fmt = 1`, `chunkBytes = 262144`, `size > 0`, `n = ceil(size/chunkBytes)`, length is exactly `41 + 32n`, `n ≤ 65535`, and `size ≤ maxBlobBytes` of the local configuration.

## Verification (receiver, in this order; first failure stops and discards)

1. `H(manifest) == id` from the reference (or from the `get` the chunk answers).
2. Manifest well-formed; `scopeId`/`keyId` equal the reference's `scope`/`keyId`; `size` equals the reference's `size`.
3. For each received chunk `i` (any order): `H(stored_i) == d_i`; `len(stored_i)` is `12 + len_i + 16`. **Only now is it written to storage.**
4. On read (open): AES-GCM decrypt with `aad_i`; a tag failure aborts the stream with `BlobIntegrityError`.
5. After the last chunk: total plaintext length equals `size`.

Steps 1–3 need no key, so a relay performs them. Steps 4–5 need the scope key.

## Reference

```json
{ "$blob": 1, "id": "<43 chars>", "size": 104857600, "type": "image/jpeg",
  "space": "<space id>", "scope": "<space or share id>", "keyId": "<16 hex>", "name": "photo.jpg" }
```

`scope` is the share ID when the owning object is in an override share at attach time (via the same `scopeFor` rule as 002 packets). `keyId` identifies the epoch used.

## Compatibility

| Situation | Required behavior |
|---|---|
| Reference with `$blob` ≠ 1 | Keep and relay; views show "unsupported attachment"; no fetch attempted |
| Manifest `fmt` ≠ 1 or `chunkBytes` ≠ 262144 | Reject for that blob (`verification`), keep the reference; a future `blob-aes-gcm/2` is introduced with a new `fmt` and registered alongside |
| Peer without `@sync/blobs` | The reference is an ordinary field value; it syncs and is stored. No blob traffic exists to that peer (lane not advertised). No data is corrupted or lost; the attachment is simply not fetchable there |
| Rotation after attach | Reads select the key by `keyId`. Old blobs are not re-encrypted (parity with packets in 002). A removed member keeps what they already downloaded and cannot fetch decryptable new-epoch blobs |
| Object moved into an override share after attach | Parity with packets: the existing blob stays readable under the old scope key. Apps that need it unreadable re-attach under the share (documented in the module docs) |
| Changing HKDF info, AAD layout, nonce derivation, chunk size, or manifest layout | MAJOR: new `fmt` and codec ID, with both supported during a transition |

## Known-answer vectors

`packages/blobs/tests/vectors/` holds a fixed key, a small plaintext (1 byte, exactly one chunk, one chunk plus one byte), expected manifests, IDs, and chunk bytes. Another implementation conforms when it reproduces them.
