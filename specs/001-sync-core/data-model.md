# Data Model: Sync Core

## Entities

### DataPacketEnvelope (stored in `packets`, sent on the wire)

| Field | Type | Notes |
|---|---|---|
| `v` | uint | Envelope format version. Currently `1` |
| `id` | string | `author + ":" + seq`. Globally unique |
| `author` | DeviceId | 128-bit random, base32. Created at install |
| `seq` | uint | Per-author monotonic, starts at 1. Persisted atomically with the packet |
| `space` | SpaceId | String. Spec 002 defines semantics |
| `clock` | HLCString | `wwwwwwwwwwww-cccc-<deviceId>`. Lexicographic order is clock order |
| `codec` | string | ID of the payload codec that produced `body` |
| `body` | bytes | Codec output. See PacketBody |
| `sig` | bytes or null | Signature slot, filled by spec 002. `null` in dev |

Immutable once created. The raw received bytes are kept, and relays forward them untouched.

### PacketBody (inside `body`, readable only after decode)

| Field | Type | Notes |
|---|---|---|
| `obj` | ObjectId | Globally unique, random 128-bit |
| `op` | `create` or `update` or `delete` | |
| `type` | string | Declared type name |
| `schemaVersion` | uint | Schema version of the type when authored |
| `fields` | map<string, JSONValue> | Changed fields only. Empty for `delete`. A `null` value is a real value. Use the explicit marker `{"$unset":true}` to remove a field |

### SyncableObject (stored in `objects`, key `obj`)

| Field | Type | Notes |
|---|---|---|
| `id` | ObjectId | |
| `type` | string | Set from the lowest-clock packet seen |
| `space` | SpaceId | Same rule |
| `schemaVersion` | uint | Highest seen |
| `fields` | map<string, {value, clock}> | Per-field clock |
| `deleted` | bool | Sticky tombstone flag |
| `deleteClock` | HLCString or null | Clock of the winning delete (highest) |
| `createdClock` | HLCString | Lowest packet clock seen |
| `updatedClock` | HLCString | Highest packet clock seen |

**Visibility**: `visible = !deleted || (type.resurrects && maxFieldClock > deleteClock)`. Queries return only visible objects.

### OutboxEntry (`outbox`, key `id`)

`{ packetId, space, createdAt, confirmedBy: Set<PeerId> }`. An entry is removed once the retention policy says at least one peer or hub (the configurable `confirmThreshold`, default 1) has acknowledged the packet. Packets stay in `packets` regardless.

### SyncSummary (`summary`, key `space`)

`{ space, held: Map<DeviceId, IntervalList> }` where `IntervalList = [[lo, hi], ...]`, sorted, merged, inclusive. The summary is updated in the same transaction that stores a packet. Compacted ranges stay in `held`.

### Snapshot (`snapshots`, key `space:coveredThroughClock`)

`{ space, covers: Map<DeviceId, IntervalList>, objects: Map<ObjectId, SyncableObject>, createdAt }`. State-based. Installing it merges each object with the same join as a packet (see below).

### ParkedPacket (`packets` with `status: "parked"`)

A packet that is stored and counted as held but cannot be applied yet. Reasons: `undecodable-codec`, `unknown-version`, `validator-deferred`. It is retried on `revalidate()`.

### Meta (`meta`)

`deviceId`, `seqCounter`, `hlcState`, `config`. Written atomically with packet writes.

## Merge rules (the only state-change logic)

```
applyPacket(env):
  if env.id in held(env.space): return NOOP                 # idempotent, before decode
  run validators(apply)  → reject: drop+report, defer: park
  body = codec.decode(env.body)    → undecodable: park
  obj  = load(body.obj) or stub(body.type, env.space)
  obj.createdClock = min(obj.createdClock, env.clock);  type/space follow the min-clock packet
  obj.updatedClock = max(obj.updatedClock, env.clock)
  switch body.op:
    create, update:
      for (f, v) in body.fields:
        if env.clock > obj.fields[f].clock:  obj.fields[f] = {v, env.clock}
    delete:
      obj.deleted = true
      obj.deleteClock = max(obj.deleteClock, env.clock)
  record held(env.id), store packet, store obj          # one transaction
  emit change(obj.type, obj.id)
```

Properties relied on and tested (SC-004):

- **Idempotent**: re-applying a packet leaves the state unchanged.
- **Commutative and associative**: the result depends on the set of packets, not their order.
- **Convergent state hash**: `hash(canonical(objects sorted by id))` is equal on all peers holding the same packet set.

Snapshot install runs the same field-wise join over `snapshot.objects` (take the greater clock per field, OR the tombstone).

## Local write path

```
write(change):
  tick HLC (bounded by maxDrift)
  clock(field) = max(hlc, next(existingFieldClock))   # lets users overwrite what they have seen
  seq = ++seqCounter
  build body → codec.encode → envelope(sig slot) → validators(send)
  applyPacket(env)         # same path as remote
  add to outbox
```

## State transitions

**Object lifecycle**

```
(absent) ──create/update──► live ──delete──► tombstoned
                              ▲                  │
                              └ edit resurrects ─┘   (only if type opts in; spec 003)
```

**Packet lifecycle**

```
received ──dup──► dropped (no effect)
   │
   ├─ reject ───► discarded + reported
   ├─ defer/undecodable/unknown-version ─► parked ──revalidate ok──► applied
   └─ ok ───────► applied ──retention window──► compacted (folded into snapshot)
```

**Transport/peer session**

```
idle → connecting → handshake(hello) → summary exchange → streaming(want/packets) ⇄ live
        ↑ disconnect/error (back to connecting, resumes from summaries)
```

## Validation rules (from requirements)

| Rule | Source |
|---|---|
| Envelope must parse, `id == author:seq`, `clock` well-formed, else reject | FR-004 |
| `seq` must not exceed the author's known max by more than a sanity bound before gaps are reported | R-05 |
| Clock bound: remote clock never advances local HLC beyond `now + maxDrift` | FR-008 |
| Unknown codec, version or type: park, store, relay | FR-009 |
| Delete packets carry no fields | FR-011 |
| Tombstones are never purged inside the retention window | FR-011 |

## Defaults (configurable)

`retentionWindowDays = 30`, `maxDriftMs = 300000`, `relay = true`, `batchPackets = 500`, `batchBytes = 1 MB`, `confirmThreshold = 1`.
