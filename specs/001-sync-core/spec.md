# Feature Specification: Sync Core

**Feature Branch**: `001-sync-core`
**Created**: 2026-10-20
**Status**: Draft
**Depends on**: none (foundation)
**Depended on by**: 002-spaces-security-identity, 003-modules-app-assembly, 004-blob-sync
**Input**: User description: "Every item/post/object is a syncable item stored offline on the client. Apps are offline first and update in realtime as updates arrive. Updates arrive as Data Packets (create, update, delete). Transport is pluggable, from a traditional server backend to Bluetooth sync and anything in between."

## Scope

This spec covers the local object store, the Data Packet pipeline, convergence (conflict resolution), the Transport contract with two reference transports, and history/compaction.

It defines **extension points** that later specs fill in:
- *Packet validators*: run before a packet is applied or sent. Spec 002 adds signature/role checks; spec 003 adds schema checks.
- *Payload codec*: turns fields into packet payload bytes and back. Spec 002 provides the encrypting codec.

During development of this spec alone, a plaintext test codec and no-op validators MAY be used. Per Constitution Principle V, no release may ship without spec 002.

## Clarifications

### Session 2026-10-20

- Q: How do concurrent offline edits resolve? → A: Per-field last-writer-wins on a hybrid logical clock.
- Q: Multiple transports at once? → A: Yes, simultaneously, with dedup and relay.
- Q: Packet history? → A: Keep the log, compact into snapshots after a retention window.
- Q: Which v1 reference transports? → A: WebSocket server + Web Bluetooth. *(superseded below)*
- Q: Web Bluetooth can't connect two browsers (browsers can only act as Bluetooth clients). How should the second reference transport work? → A: Drop Bluetooth from v1; the second reference transport is browser-to-browser WebRTC. Bluetooth remains a possible future transport behind the same contract.
- Q: How do two browsers introduce themselves before a WebRTC connection? → A: Manual signaling (QR code or pasted code); no server required.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work Fully Offline (Priority: P1)

An End User opens an installed app with no connectivity, creates, edits, and deletes objects, closes the app, and reopens it later. Everything they did is still there.

**Why this priority**: Offline-first is the foundation. Nothing else matters if local state isn't reliable.

**Independent Test**: Disable all transports, perform CRUD on objects, reload, verify state persists and the outbox holds the matching packets.

**Acceptance Scenarios**:

1. **Given** no transport is connected, **When** the user creates an object, **Then** it is visible immediately and persists across reloads.
2. **Given** an existing object, **When** the user edits a field offline, **Then** the change appears immediately and a Data Packet is recorded in the local outbox.
3. **Given** an existing object, **When** the user deletes it offline, **Then** it disappears from all queries and a delete packet is recorded.

---

### User Story 2 - Realtime Updates From Data Packets (Priority: P1)

Two devices are online. When one edits an object, the other sees the change in its open view without refreshing.

**Why this priority**: "Updates in realtime" is a core promise, and it proves the packet pipeline end to end.

**Independent Test**: Two devices on the WebSocket transport; edit on device A, verify a live query on device B updates.

**Acceptance Scenarios**:

1. **Given** two connected devices observing the same object, **When** device A updates a field, **Then** device B's live query emits the new value without user action.
2. **Given** a live query over a type, **When** a create packet for that type arrives, **Then** the query result includes the new object.
3. **Given** a packet that was already applied, **When** it arrives again (from the same or another transport), **Then** state is unchanged and no query emits.

---

### User Story 3 - Converge After Being Offline (Priority: P1)

Two devices edit independently while offline, including the same object. When they reconnect, both end up with the same state automatically.

**Why this priority**: This is where offline-first apps usually break; convergence must be guaranteed before anything is built on top.

**Independent Test**: Partition devices, apply randomized edits on both, reconnect, compare full state hashes.

**Acceptance Scenarios**:

1. **Given** A and B edited *different* fields of the same object offline, **When** they sync, **Then** both edits are kept on both devices.
2. **Given** A and B edited the *same* field offline, **When** they sync, **Then** both keep the same value, chosen by per-field last-writer-wins.
3. **Given** any set of packets delivered in any order, **When** all are applied, **Then** every device holding that packet set has identical state.
4. **Given** A deleted an object and B edited it concurrently, **When** they sync, **Then** the object is deleted on both (FR-012).

---

### User Story 4 - Pluggable, Simultaneous Transports (Priority: P2)

An App Developer configures an app to sync through a WebSocket server and direct browser-to-browser WebRTC at the same time. A Module Author writes a new transport by implementing one contract.

**Why this priority**: Transport independence is a defining feature, but it builds on Stories 1–3.

**Independent Test**: Run the Transport contract test suite against both reference transports; run both in one app and verify dedup and relay.

**Acceptance Scenarios**:

1. **Given** two transports active at once, **When** the same packet arrives on both, **Then** it is applied once.
2. **Given** A is connected only via server and C only via WebRTC to B, **When** A writes, **Then** C eventually receives it through B (relay), if relay is enabled.
3. **Given** a transport drops mid-sync, **When** it reconnects, **Then** sync resumes by exchanging only missing packets.
4. **Given** a WebRTC connection that cannot be established (no WebRTC support, or blocked by the network), **When** the app starts or a connection attempt fails, **Then** the WebRTC transport reports "unsupported" or "unavailable" and the app continues on WebSocket.
5. **Given** two devices with no internet and no server, **When** the users exchange pairing codes (QR or paste), **Then** the devices connect over WebRTC and sync.
6. **Given** a new transport implementation, **When** it passes the contract suite, **Then** it works in any app without core changes.

---

### User Story 5 - History, Undo, and Compaction (Priority: P3)

The packet log supports undo and catching up peers. After a retention window, old history is compacted into snapshots so storage doesn't grow forever.

**Why this priority**: Needed for long-lived apps, but not for proving sync.

**Independent Test**: Generate a long history, compact, verify state is unchanged, a fresh peer can bootstrap from the snapshot, and undo works within the window.

**Acceptance Scenarios**:

1. **Given** the user makes an edit, **When** they undo within the retention window, **Then** a new compensating packet restores the prior field values.
2. **Given** history older than the retention window, **When** compaction runs, **Then** current state is identical before and after.
3. **Given** a peer offline longer than the retention window, **When** it reconnects, **Then** it resyncs from a snapshot plus newer packets and still converges.

---

### Edge Cases

- Device clock is badly wrong (hours or years off): ordering must still converge, and one device must not "win" forever.
- A packet references an object type this device doesn't know: store and relay it, don't drop it.
- A transport delivers a corrupted or truncated packet: reject it without affecting other packets.
- Storage quota exceeded on the device (IndexedDB eviction, iOS storage limits).
- Very large initial sync (many objects, long history).
- A peer on an older Framework version receives a packet in a newer format.
- A pairing code is malformed, expired, or already used: pairing fails with a clear error and nothing is synced.
- Two WebRTC peers cannot reach each other directly (restrictive NAT or firewall): the connection fails cleanly and the app keeps using other transports.
- A relay loop (A→B→C→A) must not cause packets to bounce forever.

## Requirements *(mandatory)*

### Functional Requirements

**Objects & storage**

- **FR-001**: The Framework MUST store every synced record as a Syncable Object with a globally unique ID, type, Space ID, schema version, fields, and per-field clocks.
- **FR-002**: The Framework MUST persist objects, the packet log, and the outbox locally so the app works with no transport.
- **FR-003**: The Framework MUST expose a reactive query API (by ID, by type, by filter) that emits when matching objects change.

**Data Packets**

- **FR-004**: Every create, update, and delete MUST be an immutable Data Packet with: unique ID, author device ID, Space ID, object ID, operation, clock timestamp, payload (changed fields), and signature slot.
- **FR-005**: Local and remote changes MUST be applied through the same packet-apply path, including validators.
- **FR-006**: Packet application MUST be idempotent and order-independent.
- **FR-007**: Concurrent field changes MUST resolve by per-field last-writer-wins, ordered by a hybrid logical clock with a deterministic tiebreaker (device ID).
- **FR-008**: Clocks from packets too far in the future (configurable bound) MUST NOT advance the local clock beyond that bound.
- **FR-009**: Packets for unknown types or newer format versions MUST be stored and relayed, not discarded.
- **FR-010**: The Framework MUST provide packet validator and payload codec extension points used on both send and apply.

**Deletes**

- **FR-011**: Deletes MUST be recorded as tombstones that sync like any packet and are retained at least as long as the retention window.
- **FR-012**: When a delete and an edit are concurrent, the object stays deleted, unless the type opts into "edit resurrects" (option defined by spec 003 schemas).

**Transports**

- **FR-013**: The Framework MUST define a single Transport contract (lifecycle, capability/support check, send packets, receive packets, sync-state exchange, blob transfer hooks) and ship a reusable contract test suite.
- **FR-014**: Multiple transports MUST run simultaneously; packets MUST be deduplicated by ID.
- **FR-015**: Devices MUST be able to relay packets between transports, configurable per app and per Space, without relay loops.
- **FR-016**: Sync MUST be resumable: peers exchange a compact summary of what they hold and send only what is missing.
- **FR-017**: v1 MUST ship two reference transports: a WebSocket server transport (with a minimal reference relay server that stores and forwards opaque packets) and a browser-to-browser WebRTC data-channel transport that pairs with manual signaling (the users exchange a QR code or pasted code; no server is required). Where WebRTC is unavailable or a connection cannot be established, that transport MUST report itself unsupported or unavailable without affecting the app. Bluetooth is not a v1 transport.

**History**

- **FR-018**: The packet log MUST be retained for at least a configurable retention window and support undo via compensating packets.
- **FR-019**: History older than the retention window MUST be compactable into snapshots without changing state; peers MUST be able to bootstrap from a snapshot.

### Key Entities

- **Syncable Object**: ID, type, Space ID, schema version, fields, per-field clocks, tombstone flag.
- **Data Packet**: ID, author device, Space ID, object ID, operation, clock, payload, signature.
- **Outbox**: locally authored packets not yet confirmed by any peer.
- **Sync Summary**: compact description of which packets a peer holds, used for resumable sync.
- **Transport**: plugin that moves packets (and blob chunks, per spec 004) between devices.
- **Snapshot**: compacted state of a Space at a point in the log.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of CRUD operations succeed with all transports disconnected and survive app restart.
- **SC-002**: Local edits appear in live queries in under 50 ms on a mid-range phone.
- **SC-003**: A remote edit appears on another online device within 1 second (p95) on a normal network.
- **SC-004**: In randomized partition tests (≥10,000 runs, random edits and delivery orders, skewed clocks), 100% of runs end with identical state hashes on all peers.
- **SC-005**: A new transport that passes the contract suite works without modifying core code.
- **SC-006**: After compaction, local storage for a Space with 100k historical packets drops by at least 80% with no state change.

## Assumptions

- Default retention window: 30 days.
- Relay is on by default.
- WebRTC works in all current major browsers, including iOS Safari. Direct connections may fail behind restrictive networks, so WebSocket remains the fallback. Manual pairing works fully offline on the same local network. Connecting across different networks may need a relay (STUN/TURN) that v1 does not provide by default.
- The reference relay server is a convenience for testing and small deployments, not a required backend.
