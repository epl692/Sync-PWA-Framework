# Data Model: Spaces, Security & Identity

Entities from the spec, mapped to what is stored, where, and how they change. Control entities are **create-only `$sys.*` objects** in the Space log (research R-06). Rules: [contracts/authority-rules.md](./contracts/authority-rules.md). Wire formats: [contracts/crypto-envelope.md](./contracts/crypto-envelope.md).

## Derived (Authority State, per Space; cached, rebuildable)

| Entity | Fields | Source events |
|---|---|---|
| **Space** | `id`, `name?`, `genesis {user, device, clock}`, `currentEpoch`, settings `{relay, retentionDays}` | `$sys.genesis`, `$sys.epoch` |
| **Membership** | `user`, `role` (`owner\|editor\|viewer`), `status` (`active\|removed`), `addedBy`, `inviteId?`, `sinceClock`, `removedClock?` | `$sys.member` |
| **User** | `userId`, `displayName?`, `devices[]` | `$sys.device` |
| **Device** | `deviceId`, `user`, `signPub`, `agreePub`, `binding {kind, proof}`, `name?`, `status` (`active\|revoked`), `revokedClock?`, `cutoffSeq?` | `$sys.device`, `$sys.device-revoke`, `$sys.member remove` |
| **Invite** | `inviteId`, `role`, `expiresAt`, `maxUses`, `secretHash`, `approval`, `uses[]`, `revoked` | `$sys.invite`, `$sys.invite-revoke`, `$sys.member add` |
| **Key Epoch** | `scope`, `epoch`, `keyId`, `prevKeyId`, `createdBy`, `clock`, `isCurrent` | `$sys.epoch` |
| **Override Share** | `shareId`, `obj`, `members[{user, role}]`, `currentEpoch` | `$sys.share`, `$sys.share-member`, `$sys.epoch` (scope = shareId) |

`scope` is the Space ID or a `shareId`.

## Stored control objects (`objects`/`packets` stores of 001)

Common to all `$sys.*`: `op = create` only; random `obj` ID; author signature; body encrypted with the current epoch key, except `$sys.keygrant` (cleartext `grant/1` body). Fields per type are listed in the authority rules. None is compacted (A-6). None appears in untyped queries (A-5).

## Local-only (database `sync-keys`; never synced or exported)

| Store | Key | Value | Notes |
|---|---|---|---|
| `device` | `"self"` | `{ signPriv: CryptoKey, agreePriv: CryptoKey, wrapKey: CryptoKey, signPub, agreePub, deviceId, userId, displayName }` | `CryptoKey`s are non-extractable. One record per install |
| `epoch-keys` | `scope:epoch:keyId` | `{ wrapped: bytes, nonce, createdAt, source: 'self'\|'grant'\|'join' }` | AES-GCM wrapped by `wrapKey`. Never plaintext |
| `counters` | `scope:epoch:keyId` | `{ packetsEncrypted }` | Nonce-safety guard (auto-rotate at 2^31) |
| `authority-cache` | `space` | `{ state, throughClock, eventCount }` | Rebuildable from the log |
| `verified` | `packetId` | `{ verdict, at }` | Signature verdict cache, bounded LRU. Rebuilt, never trusted from older versions (cleared on version bump) |
| `invites-local` | `inviteId` | `{ secret }` | Only on the creating device |

## Messages (not stored)

`join-request`, `join-pending`, `join-grant`, `join-deny`, `link-offer`, `link-accept` on channel `identity/1`. See [contracts/join-protocol.md](./contracts/join-protocol.md).

## Relationships

```
User 1─* Device            Device 1─* Packet (author)
User *─* Space  (Membership: role)
Space 1─* KeyEpoch         Space 1─* Invite     Space 1─* OverrideShare
OverrideShare 1─1 Object   OverrideShare 1─* KeyEpoch    OverrideShare *─* User (subset of Space members)
KeyEpoch 1─* KeyGrant (one per recipient Device)
```

## State transitions

**Membership (per user in a Space), replayed in clock order**

```
(absent) ──add [Owner author, invite valid]──► active/role
active/role ──role [Owner author, keeps ≥1 Owner]──► active/role'
active/* ──remove [Owner author or self, keeps ≥1 Owner]──► removed (devices cut off at cutoff seq)
removed ──add [Owner author, new invite]──► active/role
(any event failing its test) ──► inert (kept in log, no effect)
```

**Device**

```
(absent) ──$sys.device [bound device of same user, or Owner adding joiner]──► active
active ──$sys.device-revoke / member remove──► revoked (valid only for clock < R and seq ≤ cutoff)
```

**Key epoch (per scope)**

```
epoch n ──rotate (member removed, device revoked, surplus invite, manual, 2^31 packets)──► epoch n+1
concurrent rotations ──► both keys decrypt (by keyId); lowest-clock event is "current" for writes
```

**Packet verification** (receiving side)

```
received → dup? drop
         → envelope check: bad sig → reject | unknown device key → defer | revoked/beyond cutoff → reject | role can't write → reject
         → decode: missing key → park (waiting-for-key) | malformed → reject
         → body check: role/scope/immutability fail → reject
         → apply  → (if control event at an earlier clock than applied packets) rebuildSpace
reject → not applied, not relayed, counted, reported
```

**Invite**

```
created ──member.add valid (uses < maxUses, before expiry)──► used n/maxUses ──(n = max)──► used-up
created/used ──now ≥ expiresAt──► expired     created/used ──invite-revoke──► revoked
```

## Validation rules (from requirements)

| Rule | Source |
|---|---|
| Every object belongs to exactly one Space; role is one of three | FR-001, FR-002 |
| At least one active Owner at all times | FR-003 |
| Control changes are signed packets, create-only | FR-004 |
| Concurrent control changes resolve by replay in clock order, inert on conflict | FR-005 |
| Payload encrypted before leaving the device; visible metadata limited to `id, space, author, seq, clock, codec` + `scope, epoch, keyId` | FR-006 |
| Every packet signed; signature and role verified before apply or relay | FR-007 |
| Removal and revocation rotate affected keys | FR-008 |
| Removed/revoked author valid only for `clock < R` and `seq ≤ cutoff` | FR-009 |
| Grants for all entitled epochs reach offline members through normal sync | FR-010 |
| Share has own members, roles, keys; non-members store and relay | FR-011, FR-012 |
| Provider contract and suite | FR-013 |
| Invite has role, expiry, max uses; offline acceptance over a local transport | FR-014 |
| Multiple devices per user, each with its own key; any can revoke another | FR-015 |

## Limits and defaults (configurable)

`maxInviteDays = 30`, `inviteApprovalTimeoutMs = 300000`, `joinHistory = 'all'`, `maxParkedPerAuthor = 1000`, `maxDevicesPerUser = 10`, `maxMembersPerSpace = 100` (soft; the UI warns), `rotateAtPackets = 2^31`, `verifiedCacheEntries = 50000`.
