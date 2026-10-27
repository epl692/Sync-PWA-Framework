# Contract: Blob Lane Protocol (`blob/1`)

Carried over the **binary lane** (amendment C-1): every message starts with the lane magic `0xB1`, then a type byte, then the body. The lane is separate from the 001 JSON sync protocol and does not share its per-peer queue.

## Framing

```
byte 0     0xB1   lane magic
byte 1     type
byte 2..   body
```

Integers big endian. `idRaw` = the 32 raw bytes of the blob ID. JSON bodies are UTF-8 and ≤ 4 KiB.

| Type | Name | Body | Direction |
|---|---|---|---|
| `0x01` | `hello` | JSON `{v:1, window, maxChunks, serve: bool}` | both, first |
| `0x02` | `offer` | JSON `{space, id, size}` | holder → peer |
| `0x03` | `get` | `idRaw(32)`, `flags u8` (bit0 = send manifest), `spaceLen u8`, `space`, `nRanges u16`, ranges `(lo u32, hi u32)` inclusive | wanter → holder |
| `0x04` | `manifest` | `idRaw(32)`, manifest bytes | holder → wanter |
| `0x05` | `chunk` | `idRaw(32)`, `index u32`, stored chunk bytes (`nonce‖ct`) | holder → wanter |
| `0x06` | `miss` | `idRaw(32)`, `nRanges u16`, ranges | holder → wanter |
| `0x07` | `stored` | `idRaw(32)` | receiver → sender (blob complete and verified) |
| `0x08` | `reject` | JSON `{id, reason}` (`quota`, `too-large`, `space`, `busy`, `unsupported`) | receiver → sender |
| `0x09` | `cancel` | `idRaw(32)` | either |

Unknown types are ignored (forward compatibility). A message larger than the transport's `maxMessageBytes`, or larger than `limits.maxMessageBytes`, is dropped and reported; the connection stays open.

## Session

1. A lane peer exists only if its sync `hello` advertised `lanes ∋ 0xB1`. Both sides then send blob `hello`; `window` is the number of chunk messages the sender is willing to have outstanding toward it (default 8, 32 on `capabilities.blobs` transports). `serve: false` means "I will not answer `get`" (a device that wants to save upload bandwidth).
2. **Offer.** A holder sends `offer` for each blob of a Space both sides sync that it has not seen `stored` from this peer for. The receiver replies by sending `get` (it wants it), `stored` (it already has all of it), or `reject`.
3. **Get.** The wanter sends `get` with `flags.bit0` set the first time (it lacks the manifest) and the chunk ranges it wants. The holder replies with `manifest` (if asked), then `chunk` messages for ranges it has, then `miss` for ranges it lacks. The wanter keeps at most `window` chunks outstanding to that peer and sends further `get`s as chunks arrive.
4. **Verify and store.** Each chunk and the manifest are verified as in [blob-format.md](./blob-format.md) before being stored. A failing chunk is discarded and counted against that peer; the range is re-requested from another peer, or from the same peer after a back-off if it is the only one. A peer that fails verification three times for one blob is not asked again for it this session.
5. **Complete.** When every chunk is stored the receiver sends `stored`. The sender records the peer in `replicas`.
6. **Resume.** After any disconnect the wanter restarts at step 3 for the chunk indexes it does not yet have. Chunks already stored are never requested again.
7. **Cancel.** `cancel` stops serving that blob to that peer; in-flight chunks are dropped.

## Rules

- A holder answers `get` only for a Space that is in both sides' sync `hello` for that peer; otherwise `reject {reason:'space'}`.
- A holder never serves a chunk it has not itself verified.
- Responders yield to the event loop between chunks and never queue more than `window` chunk messages per peer (keeps packets flowing, FR-003).
- A relay (`BlobRelay`, amendment R-1) answers `offer` with `get` only when it passes its caps (`quota`, `too-large`), and serves `get` like any holder. It verifies manifest and chunk digests but has no key.
- Duplicated, reordered, or replayed messages are harmless: chunks are verified and idempotently stored, `stored` and `offer` are idempotent.
- A peer may send `get`/`offer` for a blob it does not hold keys for; this exposes only ciphertext and sizes, which a relay already sees.

## Compatibility

Additive only. Peers that did not advertise the lane never receive a lane message. A peer that advertises the lane but a different blob version (`hello.v ≠ 1`) is handled as "no blob lane" for that session. 001 and 002 packet sync is unaffected.
