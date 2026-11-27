# Contract: Bluetooth Link Protocol (`link/1`)

What a browser client and a Hub (or two Hubs) speak over GATT. The sync protocol (spec 001), packet envelope, and blob lane (spec 004) are carried unchanged as opaque messages inside this link. Decisions and rationale: [research.md](../research.md) R-02 to R-06, R-16.

## GATT layout

| Item | UUID | Properties |
|---|---|---|
| Service `link/1` | `a89242f7-786e-4bf2-9b00-b028957dc0eb` | Advertised (primary) |
| `INFO` | `c71b9f0e-0fc5-48bd-9bff-6428700a9eea` | read |
| `TX` | `9ec66df3-0a3e-4c6a-a381-37405b5ac00c` | write without response, write |
| `RX` | `16d9aa8a-90ef-407b-a339-80534210840d` | notify |

Advertising: service UUID in the advertisement, display name in the scan response. Nothing about Spaces, clients, or packets is advertised (spec FR-014).

`INFO` value (UTF-8 JSON, at most 512 bytes, readable before any handshake):

```json
{ "v": [1, 1], "name": "Camp hub", "fp": "<fingerprint>", "mode": "open|approval",
  "slots": 3, "full": false, "maxWrite": 244 }
```

`slots` is free client slots, `maxWrite` is the largest write the Hub will accept in one frame (an upper bound for the probe). A client whose `v` range does not overlap shows "update needed" and does not connect further.

## Frames

A **frame** is one GATT write (client to Hub, `TX`) or notification (Hub to client, `RX`). Maximum frame size is the negotiated `frameBytes` (20 to 244, [Frame size](#frame-size-negotiation)).

```
byte 0:  bits 7-6 type   00 DATA   01 ACK   10 PROBE   11 reserved (drop)
         bit 5   stream  0 control+packets   1 binary lane
         bit 4   START   first frame of a message
         bit 3   END     last frame of a message
         bits 2-0 reserved, MUST be 0, ignored on receipt
byte 1:  seq (8-bit, per stream and direction, wraps)
bytes 2..: payload (DATA), or for ACK: 1 byte = highest in-order seq received on that stream;
           for PROBE: filler to the probe size
```

- A message that fits one frame has both `START` and `END`.
- **Sequence.** Each stream and direction starts at 0 on connect and increments per DATA frame. A received DATA frame whose `seq` is not `last + 1` aborts the message in progress on that stream (partial bytes discarded, `link.error: frame-gap` reported); the receiver then waits for the next `START` and resyncs its expected `seq` to it.
- **Window.** At most 32 unacknowledged DATA frames per stream and direction. The receiver sends `ACK` every 16 frames and at `END`. A sender with a full window pauses.
- **Fairness.** After 4 consecutive stream-1 frames the sender MUST offer stream 0 a turn if it has frames queued.
- **Reassembly.** A partial message older than 30 s is dropped. Reassembled size over `maxMessageBytes + 24` aborts the message and counts one strike.
- **Corruption.** Frames shorter than 2 bytes, reserved type, or `START` inside a message abort the message. They never close the connection unless 3 occur within 10 s.

### Frame size negotiation

1. Both sides begin at 20-byte frames.
2. After the secure handshake the client sends `PROBE` frames of 64, 128, 182, and 244 bytes, each as its own write without response, spaced 50 ms apart.
3. The Hub replies with encrypted control message `probe-result { "received": [64, 128] , "notify": 182 }`: the sizes received intact and the largest notification the Hub can send (known from its MTU).
4. Client uses `min(largest received, Hub notify limit)` for writes and the Hub's notify limit for reads. If none arrive, stay at 20.
5. A write error at runtime halves `frameBytes` (floor 20) and retries the frame; it never gives up the connection for a size error alone.

## Messages

Encoding before encryption: first byte is the **kind**.

| Kind | Meaning | Body |
|---|---|---|
| `0xF0` | `hello` (plaintext, client to Hub) | JSON, see below |
| `0xF1` | `hello-ack` (plaintext, Hub to client) | JSON, see below |
| `0xE0` | encrypted message | `counter (8 B BE) | AES-256-GCM(inner)` |

Inner plaintext of an `0xE0` message: first byte is the **inner kind**.

| Inner kind | Meaning | Body |
|---|---|---|
| `0x00` | control | UTF-8 JSON object with a `t` field |
| `0x01` | core message | bytes handed to the core as a transport message (sync protocol message, or a lane message beginning with a registered lane magic). Carried on stream 0 or 1 per the `lane` bit |

### Secure handshake

```
client                                           hub
  | hello {v:[min,max], ek, nc}  ---------------> |
  | <------- hello-ack {v, ek, nh, hubKey, sig, busy?}
  |   (derive session keys)                       |
  | enc auth {...}  ----------------------------> |
  | <---------------------------- enc auth-ok / pending / reject
  | enc probe frames, enc probe-result            |
  | ... sync protocol (hello, summary, packets) ...
```

- `ek` is an ephemeral X25519 public key, `nc` and `nh` are 16 random bytes each (base64url).
- `hello-ack.sig = Ed25519(hubKey, "sync-link/1" || clientEk || hubEk || nc || nh || hubFingerprintBytes)`.
- Session keys: `HKDF-SHA-256(ECDH(ekc, ekh), salt = nc || nh, info = "sync-link/1 keys")` giving `c2h` and `h2c` AES-256 keys, 32 bytes each.
- Nonce: 4 zero bytes then the 8-byte counter (direction fixed by which key is used). Receivers require the counter to be strictly greater than any previous one in that direction (drops replays; gaps are fine because a message can be aborted).
- The client verifies `hubKey`:
  - first contact: show `fingerprint` and name, user confirms, key is pinned (`TrustedHubRecord`);
  - known Hub: the key MUST equal the pinned key. If not, abort with `hub-identity-changed`.
- If the Hub is full it sends `hello-ack` with `busy: {retryMs}` and no keys; the client disconnects and backs off with jitter.

### Control messages

All inside `0xE0` with inner kind `0x00`.

| `t` | Direction | Fields |
|---|---|---|
| `auth` | client to Hub | `device` (device ID, spec 002), `devSig`, `name`, `spaces: [{space, epoch, sig}]`, optional `claim: [{space, epoch, accessPublicKey}]` (automatic mode only) |
| `auth-ok` | Hub to client | `state: "trusted"`, `accepted: [space]`, `rejected: [space]` |
| `pending` | Hub to client | owner approval needed. The Hub sends `auth-ok` later, or `reject` |
| `reject` | Hub to client | `code`: `not-served` (covers unknown Space and bad proof alike), `blocked`, `denied`, `busy` |
| `probe-result` | Hub to client | see above |
| `ping` / `pong` | either | keepalive, every 15 s of idleness; 3 missed closes the link |
| `bye` | either | clean close with optional `reason` |
| `error` | either | `code`, `fatal` (matches 001 `error` semantics) |

Proofs (see [hub-access.md](./hub-access.md)):

- `sig` per Space: `Ed25519(accessPrivate(space, epoch), "sync-hub-auth/1" || hubFingerprintBytes || nc || nh || spaceId || epoch)`.
- `devSig`: `Ed25519(deviceSignKey, "sync-hub-dev/1" || hubFingerprintBytes || nc || nh)`, binding the session to the client's device key for approval records and blocks.

A rejection never says which Spaces the Hub serves (spec edge case). Rejected Spaces return the same `rejected` entry as unknown ones.

After `auth-ok`, the client's sync `hello.spaces` MUST list only accepted Spaces, and the Hub's `admit(peerId, space)` gate (amendment R-2) drops anything else, including wildcard.

### Connection state machine

```
idle -> connecting -> securing -> authenticating -> [pending] -> syncing <-> idle
              \            \             \              \            \
               +------------+-------------+--------------+------------+-> disconnected | error | full
```

- `securing`: hello/hello-ack and key derivation. Timeout 10 s.
- `authenticating`: `auth` sent. Timeout 10 s; in `pending` the timeout is 10 minutes and the client UI shows "waiting for the Hub owner".
- `syncing`: sync protocol active. `idle` when summaries match and no traffic.
- Any state goes to `disconnected` on link loss. The client reconnects per its policy; the Hub forgets session keys immediately.

### Abuse limits (Hub)

| Limit | Default |
|---|---|
| Concurrent clients | min(7, platform limit); beyond that `busy` |
| Handshakes per minute per device | 6 |
| Handshakes per minute overall | 30 (the Hub answers extra with `busy`, cheaply) |
| Strikes (bad frame, oversize, bad proof, protocol violation) | 3 within 10 minutes: disconnect and block 15 minutes (spec FR-026) |
| Unauthenticated connection lifetime | 20 s |
| Messages from a client before `auth-ok` | `auth` only |

## Compatibility

- Link version range is in `INFO.v` and `hello.v`. Additive changes (new control `t` values, new optional fields) keep the major and bump the minor; receivers ignore unknown `t` and unknown fields.
- A breaking change gets a new service UUID so older clients never see the Hub as a candidate; the Hub MAY advertise both services during a transition.
- Reserved bits and frame types MUST be sent as 0 and ignored/dropped on receipt.
- The sync protocol, packet envelope, and blob lane are untouched; an older client that has this transport still speaks the same inner protocol.

## Invariants (tested)

1. Reassembly of any message split at any `frameBytes` in 20..244 equals the original.
2. A dropped or duplicated frame never produces a delivered corrupted message; the affected message is aborted and later re-requested by sync.
3. After a stream-1 flood, stream-0 latency is bounded by 4 frames per turn.
4. A replayed encrypted message is rejected.
5. A Hub with the Space's access public key but not its content keys cannot decrypt any packet (checked with the plaintext scan helper from spec 002).
6. Unauthenticated peers receive no Space, packet, or client information beyond `INFO`.
