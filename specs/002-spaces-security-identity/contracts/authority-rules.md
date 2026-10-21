# Contract: Authority Rules (deterministic fold)

The authority state of a Space is computed only from `$sys.*` control events. Every peer holding the same events computes the same state (SC-001, order independence).

## Control event types (all create-only, signed, immutable)

| Type | Fields | Who may author |
|---|---|---|
| `$sys.genesis` | `space`, `owner: {user, device}`, `name?` | The creating device. Exactly one per Space; the lowest-clock valid one wins, and the Space ID is derived from it (below) |
| `$sys.member` | `action: add\|role\|remove`, `user`, `role?`, `inviteId?`, `cutoff?` | Owner (see rules) |
| `$sys.device` | `user`, `device`, `signPub`, `agreePub`, `binding: {kind, proof}`, `name?` | A device already bound to the same `user`, or an Owner adding a joiner |
| `$sys.device-revoke` | `device`, `cutoff` | A device of the same user, or an Owner |
| `$sys.invite` | `inviteId`, `role`, `expiresAt`, `maxUses`, `secretHash`, `approval` | Owner |
| `$sys.invite-revoke` | `inviteId` | Owner |
| `$sys.epoch` | `scope`, `epoch`, `keyId`, `prevKeyId` | Owner (Space scope) or share Owner (share scope) |
| `$sys.keygrant` | `grant/1` body (codec `grant/1`) | Owner / share Owner, or a bound device of the same user for its own new device |
| `$sys.share` | `shareId`, `obj`, `members: [{user, role}]` | Space Editor or Owner who can read the object |
| `$sys.share-member` | `shareId`, `action`, `user`, `role?`, `cutoff?` | Share Owner |

`SpaceId = base32(SHA-256(canonical(genesis envelope fields: author, seq, clock)))[0..128 bits]`. The Space ID is fixed by the first packet, so nobody can claim an existing Space ID with a different genesis.

## Fold

```
state = empty
for e in sort(controlEvents, by clock):           # total order: HLC string, device ID last
  if !authentic(e): continue                      # signature, known device (else DEFER the whole fold input; see below)
  if e.author's user is not allowed to author e.type in `state`: continue   # inert, kept in log
  apply e to state
```

- **Inert, not rejected**: an event that is authentic but not allowed *in the replay state* is skipped. It stays in the log (so every peer sees the same set) and has no effect.
- **Unknown device**: if the author's public key is not in `state` yet, the event is **deferred**. The packet is parked and the fold is recomputed when the missing `$sys.device` arrives. The fold itself is only ever evaluated on events whose authors are known, so the result is stable.

## Rules enforced inside the fold

1. **Owner required** for `member`, `invite`, `invite-revoke`, `epoch` (Space scope), and keygrants to others.
2. **At least one Owner** (FR-003): a `member` event that would remove or demote the last Owner is inert.
3. **No self-promotion**: an Editor or Viewer cannot make themselves anything. `member.add/role` need an Owner author at that point of the replay.
4. **Invites**: `member.add` carrying `inviteId` is valid only if the invite exists, is not revoked, `member.clock < expiresAt`, the role equals the invite's role, and the count of earlier valid adds for this `inviteId` is `< maxUses`. Surplus adds are inert.
5. **Device cutoff**: after `device-revoke` or `member.remove` for device D at clock R with `cutoff[D] = s`, a packet from D is valid only if `clock < R` **and** `seq ≤ s`. Applies to data and control packets alike.
6. **Shares**: share members must be Space members. A share role is capped by the Space role. Removing a user from the Space removes them from every share (inert share events from non-members).
7. **Self-service**: any bound device may write `$sys.device` for its own `user` regardless of role. It cannot write other control types.
8. **Immutability**: any `update` or `delete` of a `$sys.*` object is rejected.

## Role permissions (body validator)

| Operation | Owner | Editor | Viewer |
|---|---|---|---|
| Read (holds key) | ✔ | ✔ | ✔ |
| `create`/`update`/`delete` ordinary objects | ✔ | ✔ | ✘ |
| Authoring `$sys.member`, `$sys.invite`, `$sys.epoch`, keygrants | ✔ | ✘ | ✘ |
| `$sys.device` for own user | ✔ | ✔ | ✔ |
| `$sys.share` for an object | ✔ | ✔ | ✘ |

Inside an override share, the share role applies instead of the Space role for objects bound to it.

## Retroactive change

When a newly applied control event lands at a clock earlier than already-applied packets from an affected device or role, the authority state changes retroactively and the core runs `rebuildSpace(space)` (see [core-amendments.md](./core-amendments.md) A-2). Control events are never compacted, so the fold can always be recomputed.

## Properties tested

- **Order independence**: shuffling delivery of the same control events gives an identical authority state hash.
- **Idempotent**: re-applying events has no effect.
- **Safety**: at all times at least one Owner exists; no Viewer-authored data packet is applied; no packet from a device beyond its cutoff is applied.
