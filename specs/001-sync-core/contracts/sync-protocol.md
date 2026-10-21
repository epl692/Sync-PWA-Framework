# Contract: Sync Protocol (v1)

Carried over any Transport as opaque, self-delimiting messages. The core implements this once, so transports only move bytes.

## Messages

All messages are canonical JSON objects with a `t` discriminator.

| `t` | Direction | Fields | Purpose |
|---|---|---|---|
| `hello` | both, first | `protocol: {min, max}`, `device`, `spaces: SpaceId[]`, `relay: bool` | Negotiate protocol version. Declare which Spaces this side will sync |
| `summary` | both | `space`, `held: {author: [[lo,hi],...]}` | Compact description of held packets (resumable sync) |
| `want` | both | `space`, `ranges: {author: [[lo,hi],...]}`, `max?` | Ask for specific missing packet ranges |
| `packets` | both | `space`, `items: Envelope[]` (≤ batch limits) | Deliver packets. Each is raw envelope bytes embedded as base64url |
| `snapshot` | both | `space`, `covers`, `objects` (chunked via `part`/`of`) | Bootstrap a peer whose gap is compacted away |
| `ack` | both | `space`, `ids?: string[]` or `held` delta | Confirm receipt so the sender can clear its outbox |
| `error` | both | `code`, `message`, `fatal` | Report protocol problems |
| `ping`/`pong` | both | none | Liveness. Transports may use their own |

## Session flow

1. Both sides send `hello`. Protocol = `min(max_a, max_b)`, and it fails if the ranges don't overlap (`error` with `fatal`).
2. For each Space both sides sync: exchange `summary`.
3. Each side diffs. If the peer is missing ranges that are still in the log, it sends `packets`. If the peer is missing ranges that were compacted, it first sends `snapshot` and then newer `packets`. It may also send `want` for ranges it lacks.
4. Live: each newly accepted local or remote packet is sent as `packets` to every other peer, unless `relay` is off for that Space.
5. `ack` clears outbox entries once `confirmThreshold` peers confirm.
6. After any disconnect, restart at step 1. Only the diff is re-sent.

## Rules

- Receivers apply packets via `applyPacket` (single path). Per-packet failures never fail the batch. They produce an `error` entry in telemetry.
- Dedup is by `id`. A packet already held is dropped before decode, silently.
- A node MUST NOT send a packet back to the peer it came from, and MUST skip peers whose summary already includes the packet.
- Messages larger than a transport's `maxMessageBytes` are the transport's job to frame. The core never exceeds `batchBytes`.
- Unknown `t` values are ignored (forward compatibility), logged once.
- Messages for a Space not in both `hello.spaces` are ignored.

## Resumption guarantee

If a session drops after any prefix of `packets` batches, restarting steps 1 to 3 results in the peers exchanging only the packets not yet held. No packet is required to be re-sent unless it never arrived.
