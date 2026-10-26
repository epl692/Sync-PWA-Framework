# Core Amendments (spec 001 additions required by 003)

Both are additive: no wire change, no change to existing behavior when unused, existing 001 and 002 tests must stay green unchanged.

## C-1: Mutable type registry (replaces the fixed `resurrectingTypes` set)

**Problem.** `Config.resurrectingTypes` is read once into an immutable set at `createSyncCore`. Module schemas register after the core exists, and runtime modules register much later (research R-16.1).

**Change.**

```ts
interface SyncCore {
  /** Declares type-level behavior. Idempotent. Re-evaluates live queries and undo eligibility for that type. */
  registerType(type: string, opts: { resurrects?: boolean }): void;
  unregisterType(type: string): void;
}
```

`Config.resurrectingTypes` remains and seeds the same registry. Queries over the type re-emit if visibility changes. `$`-prefixed types may not be registered (throws).

**Compatibility.** Visibility is derived from converged stored state, so peers that registered the option at different times still hold identical state; only what they show differs until they register it. Packets are unaffected.

## C-2: Per-field clocks on reads (opt-in)

**Problem.** `SyncableObject.fields` carries plain values only, but clock-aware migration (research R-07) must pick the newer of an old and a new field.

**Change.**

```ts
interface SyncableObject {
  // existing fields unchanged
  /** Present only when requested: serialized HLC of the last write per field name (unset fields included until compacted). */
  clocks?: Record<string, string>;
}
interface QuerySpec { withClocks?: boolean }
interface SyncCore { get(id: ObjectId, opts?: { withClocks?: boolean }): Promise<SyncableObject | undefined> }
```

The data is already stored on every field (`toSyncable` simply omits it). Default `false`, so existing results and equality checks are unchanged.

**Compatibility.** Pure read-API addition; no storage or wire change.

## Required tests (added to core's suites)

1. `registerType` after queries exist: a deleted+edited object becomes visible and `undo(delete)` stops throwing `NotUndoable`; unregistering reverses it.
2. `withClocks: true` returns clocks matching the HLC strings in `history()`; default results have no `clocks` key.
3. Property: with identical packet sets, two cores that call `registerType` in different orders produce equal `stateHash`.
