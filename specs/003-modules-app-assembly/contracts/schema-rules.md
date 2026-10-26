# Schema Rules

Normative rules for validation, versions, migration and merge options (FR-004..FR-006). Types are in [schema.ts](./schema.ts).

## 1. Validation (`validateBody`)

Input: a decoded packet body `{ op, type, schemaVersion, fields }` and the registered type. Output: accept or reject with `{ field?, detail }`. The function is **pure**: it reads nothing but its two arguments.

For `op = 'delete'`: accept (fields are empty by 001).

Let `k = body.schemaVersion`, `L = latest version`.

| Case | Rule |
|---|---|
| `k < 1`, non-integer, or `k` missing | reject `bad-version` |
| `1 ≤ k ≤ L` | Validate against **version k**. Every field name must be declared in version k or in an earlier version (earlier names appear as `down` mirrors), else reject `unknown-field`. Each value must satisfy the constraints and `check` of the **newest version ≤ k that declares the name**. Because a name never changes type (§2.3), this is unambiguous. |
| `k > L` | **Lenient.** For each field name this peer knows (in any of its versions) apply its type check only (not `required`, not constraints, not `check`). Unknown names pass through untouched. |
| `op = 'create'` | Additionally: every `required` field of version k (or none, when `k > L`) must be present and not `UNSET`; defaults are applied by the writer before the packet exists (`prepareWrite`), never by receivers; `objectCheck` runs on the full field set. |
| `op = 'update'` | `required` is not checked (partial field set), but `UNSET` of a required field of version k is rejected. |

`UNSET` is the 001 marker `{ "$unset": true }`; it is always type-valid except for required fields.

Field type checks: `string` (UTF-16 string, `maxLength`, `pattern` as a JS RegExp source), `number` (finite), `integer` (safe integer), `boolean`, `timestamp` (safe integer ≥ 0), `enum` (member of `values`), `ref` (non-empty string), `json` (any JSON; canonical encoding length ≤ `maxBytes`, default 64 KiB), `list` (array of the declared primitive, ≤ `maxItems`, default 256). A thrown `check` is a rejection (`check-threw`), never a crash.

### Verdict mapping (the registered `SchemaValidator`)

| Situation | `send` phase | `apply` phase |
|---|---|---|
| Type starts with `$` (spec 002) | accept | accept |
| Type registered, body valid | accept | accept |
| Type registered, body invalid | reject → `SchemaValidationError` thrown to the caller; no packet is created | reject (packet discarded and reported; 001 stores nothing for it) |
| Type unknown, boot window open | accept (local write to an unregistered type is a bug → facade refuses first) | **defer** `unknown-type` |
| Type unknown, window closed | accept | accept as opaque (kept, relayed, not projected) |

Deferred packets are retried by `core.revalidate()` which the host calls when the window closes and after each runtime module registers.

## 2. Schema lint (`checkSchema`)

Run at registration, in `checkModules`, and in `moduleContract`. Problems (non-exhaustive):

1. `versions` is non-empty, ascending, contiguous from 1.
2. For every version > 1: `up` exists; and either `down` exists or `breaking: true`.
3. A field name has the **same `type`** in every version where it appears (R-07).
4. `enum` has at least one value; `pattern` compiles; `default` satisfies its own field; `required` plus `default` is allowed.
5. Field and type names match `^[a-z][A-Za-z0-9_]{0,31}$`; no name starts with `$`.
6. `compatWrite`, if set, is within `[1, latest]`.

## 3. Versions and projection

- A write is always authored at `schemaVersion = latest` (`prepareWrite`), with defaults filled for `create`.
- **`project(reg, obj)`** produces the app-visible fields: starting from the stored fields, for `v = 1 … L-1` compute version `v+1`'s fields with `up(prev, own)` where `prev` is the field set of version v (names declared in v, with clocks) and `own` is the field set declared in v+1. `up` may only set names declared in v+1. Names declared only in older versions stay stored and hidden. The result is validated field by field against version L; invalid values are omitted and returned in `violations` (read-time check, R-09).
- `up` must be **idempotent and a pure function of its inputs**. Because inputs are the converged field values and clocks, all peers on the same versions compute the same projection.
- Helpers (`migrate.rename`, `convert`, `addDefault`) resolve "both old and new set" by comparing clocks: the later write wins; a tie uses the string order of the clocks (the 001 clock order, so it matches the core).
- **Mirroring with `down`**: for a write at version L the host computes `down(changedFields)` for L, then for L-1 … down to `compatWrite`, and adds the results to the same packet. The packet's own `schemaVersion` stays L. Mirrored names are declared in earlier versions, so §1 accepts them. The lint test-runs each `down` over the declared field set and fails if it emits a name not declared in the version it targets.

## 4. Merge options

- `editResurrects` is type-level and version independent. The host registers it with the core at activation (amendment C-1). It affects visibility and `undo` of a delete only; the stored state is identical on all peers either way, so a peer that lacks the option still converges.

## 5. Compatibility

Required by the Development Workflow whenever older peers could misread newer data.

| Receiver | Packet | Behavior |
|---|---|---|
| Peer without spec 003 (plain 001/002 core) | any | Stores, merges and relays fields as before. Sees all names, including legacy ones. No data loss. |
| v1 module | v2 packet | Accepts (lenient), stores, relays; projection shows v1 fields it knows. Unknown v2 fields are kept. Edits by this peer touch only v1 fields, so v2 fields are never overwritten. |
| v2 module | v1 packet | Validates against v1's field list, applies, projects through `up`. |
| Any | unknown type, window closed | Accept as opaque; keep and relay. |
| Any | invalid for its own version | Reject; not applied, not stored by the validator contract (001 drops rejected packets). It is not relayed by a peer that knows the schema. A peer that does not know the schema cannot tell, and relays. |
| Any | `breaking` version | Converges and loses nothing; older peers do not see changes to the affected fields. `schema:breaking` is emitted once per session. |

The last rows mean schema checks are **local hygiene against bad writers and bugs**, in addition to 002 signature and role checks, and not an authorization mechanism: an authorized member running a different schema can write what that schema allows.
