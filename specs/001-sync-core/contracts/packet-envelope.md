# Contract: Data Packet Envelope (v1)

## Canonical encoding

- UTF-8 JSON with object keys sorted lexicographically at every level, no insignificant whitespace.
- Byte fields (`body`, `sig`) are base64url without padding.
- Numbers are integers or finite doubles. `NaN` and `Infinity` are rejected.
- The signing input (spec 002) is the canonical encoding of the envelope with `sig` set to `null`.
- Peers MUST store and forward the **original received bytes**. They MUST NOT re-encode a packet before relaying it.

## Shape

```json
{
  "v": 1,
  "id": "K3F9...:42",
  "author": "K3F9...",
  "seq": 42,
  "space": "space-id",
  "clock": "0190a1b2c3d4-0003-K3F9...",
  "codec": "test-plaintext/1",
  "body": "<base64url>",
  "sig": null
}
```

## Compatibility

Required by the constitution's Development Workflow for any packet-format change.

| Situation | Required behavior |
|---|---|
| Receiver sees `v` greater than it supports | Store verbatim, count `id` as held, relay, mark `parked: unknown-version`. Apply it after upgrade |
| Receiver sees unknown **extra** envelope fields at a known `v` | Preserve (raw bytes are kept). Ignore for logic. Signature still covers them |
| Receiver sees an unknown `codec` | Park (`undecodable-codec`), store, relay |
| Decoded body has unknown `type` or higher `schemaVersion` | Apply fields as-is (generic merge). Do not drop unknown fields. Schema validation belongs to spec 003 |
| Sender is older than receiver | Receiver accepts all older `v`. `v` is only ever incremented for breaking changes. Additive changes keep `v` |
| Changing canonical encoding, `id` rule, or merge semantics | MAJOR change. Requires a new `v`, a migration note here, and a protocol `minProtocol` bump |

Rationale: an older peer must never discard or rewrite data it does not understand, because that data may be the only copy a newer peer is waiting for.

## Invariants (tested)

1. `id === author + ":" + seq`.
2. For a given `author`, `seq` is unique and strictly increasing in authoring order.
3. `clock` parses, and its `deviceId` suffix equals `author`.
4. Envelope bytes are never modified after creation.
