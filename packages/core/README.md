# @sync/core

The Sync Core: local object store (IndexedDB or in-memory), immutable Data Packets, a convergent per-field
last-writer-wins merge on a hybrid logical clock, the transport-agnostic sync protocol, and history
(undo, snapshots, compaction). No runtime dependencies.

Entry point: `createSyncCore(config)`. API: `specs/001-sync-core/contracts/public-api.ts`.

Warning: until spec 002 provides an encrypting codec and signature validators, packets are not protected.
Never register the plaintext test codec (`@sync/testkit`) in a release build.
