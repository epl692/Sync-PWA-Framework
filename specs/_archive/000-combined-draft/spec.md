# Feature Specification: Core Object Sync Framework

**Feature Branch**: `001-core-sync-framework`
**Created**: 2026-10-20
**Status**: Draft
**Input**: User description: "A framework for building modular, dynamic, static PWAs. Every item/post/object is a syncable item stored offline on the client. Apps are offline first and update in realtime as updates arrive. Updates arrive as Data Packets (create, update, delete). Transport is pluggable, from a traditional server backend to Bluetooth sync and anything in between. Views and features are added as modules."

## Personas

- **App Developer**: builds an app by assembling modules on the Framework.
- **Module Author**: writes view, feature, transport, or identity modules.
- **End User**: uses an app built on the Framework, on one or more devices, alone or in a shared Space.

## Clarifications

### Session 2026-10-20

- Q: How do concurrent offline edits resolve? → A: Per-field last-writer-wins on a hybrid logical clock.
- Q: Who shares data? → A: Multi-user, shared Spaces.
- Q: Language and view technology? → A: TypeScript core, views as Web Components.
- Q: Data privacy level? → A: End-to-end encrypted packets.
- Q: How are permissions enforced? → A: Signed packets, verified by every peer.
- Q: Unit of sharing? → A: Spaces, with optional per-object override shares.
- Q: How are modules added? → A: Both bundled at build time and loaded at runtime from a manifest.
- Q: Multiple transports at once? → A: Yes, simultaneously, with dedup and relay.
- Q: How are object types defined? → A: Declared, versioned schemas.
- Q: Packet history? → A: Keep the log, compact into snapshots after a retention window.
- Q: Binary attachments in v1? → A: Yes, as separate lazy blob sync.
- Q: How do users/devices join? → A: Pluggable identity providers; invite link/QR is the default.
- Q: Which v1 reference transports? → A: WebSocket server + Web Bluetooth.
- Q: Permission model? → A: Fixed Owner/Editor/Viewer roles only.
- Q: Cross-origin runtime modules? → A: No; same origin only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Work Fully Offline (Priority: P1)

An End User opens an installed app with no connectivity, creates, edits, and deletes objects, closes the app, and reopens it later. Everything they did is still there.

**Why this priority**: Offline-first is the foundation. Nothing else matters if local state isn't reliable.

**Independent Test**: Install the app, disable the network and all transports, perform CRUD on objects, reload, verify state persists.

**Acceptance Scenarios**:

1. **Given** the app is installed and no transport is connected, **When** the user creates an object, **Then** it is visible immediately and persists across reloads.
2. **Given** an existing object, **When** the user edits a field offline, **Then** the change appears immediately and a Data Packet is recorded in the local outbox.
3. **Given** an existing object, **When** the user deletes it offline, **Then** it disappears from all views and a delete packet is recorded.
4. **Given** the app has never connected to any transport, **When** it is launched, **Then** the app shell and all bundled modules load from the device.

---

### User Story 2 - Realtime Updates From Data Packets (Priority: P1)

Two End Users in the same Space are both online. When one edits an object, the other sees the change appear in their open view without refreshing.

**Why this priority**: "Updates in realtime" is a core promise, and it proves the packet pipeline end to end.

**Independent Test**: Two devices connected via any reference transport; edit on device A, verify view on device B updates within the latency target.

**Acceptance Scenarios**:

1. **Given** two connected devices viewing the same object, **When** device A updates a field, **Then** device B's view reflects the new value without user action.
2. **Given** a view listing objects of a type, **When** a create packet for that type arrives, **Then** the new object appears in the list.
3. **Given** a packet that was already applied, **When** it arrives again (from the same or another transport), **Then** state and views are unchanged.

---

### User Story 3 - Sync After Being Offline (Priority: P2)

Two devices edit the same Space independently while offline, including the same object. When they reconnect, both converge to the same state automatically.

**Why this priority**: This is where offline-first apps usually break; convergence must be guaranteed.

**Independent Test**: Partition two devices, apply randomized edits on both, reconnect, compare full state hashes.

**Acceptance Scenarios**:

1. **Given** devices A and B edited *different* fields of the same object offline, **When** they sync, **Then** both edits are kept on both devices.
2. **Given** A and B edited the *same* field offline, **When** they sync, **Then** both devices keep the same value, chosen by per-field last-writer-wins on the packet clock.
3. **Given** any set of packets delivered in any order, **When** all are applied, **Then** every device holding the same packet set has identical state.
4. **Given** A deleted an object and B edited it concurrently, **When** they sync, **Then** the outcome follows the delete rule in FR-014 on both devices.

---

### User Story 4 - Pluggable, Simultaneous Transports (Priority: P2)

An App Developer configures an app to sync through a WebSocket server and, at the same time, through Bluetooth with nearby devices. A Module Author writes a new transport by implementing one contract.

**Why this priority**: Transport independence is a defining feature, but it builds on Stories 1–3.

**Independent Test**: Run the Transport contract test suite against two different transports; run both in one app and verify packets dedup and relay correctly.

**Acceptance Scenarios**:

1. **Given** two transports active at once, **When** the same packet arrives on both, **Then** it is applied once.
2. **Given** device A is connected only via server and device C only via Bluetooth to device B, **When** A writes, **Then** C eventually receives it through B (relay), subject to relay settings.
3. **Given** a transport drops mid-sync, **When** it reconnects, **Then** sync resumes from where it left off without re-sending everything.
4. **Given** a new transport implementation, **When** it passes the Transport contract test suite, **Then** it can be used in any app without core changes.

---

### User Story 5 - Shared Spaces With Private Data (Priority: P2)

An End User creates a Space (e.g. "Family"), invites others, and assigns roles. Data in the Space is end-to-end encrypted. They can also share a single object privately with a subset of members (per-object override).

**Why this priority**: Multi-user is the target use case, and with E2E encryption, permissions must be enforced by every peer.

**Independent Test**: Create a Space with two members of different roles; verify a viewer's write is rejected by peers; verify a server/relay transport stores only ciphertext.

**Acceptance Scenarios**:

1. **Given** a Space with members, **When** any packet leaves a device, **Then** its payload is encrypted and it carries a valid signature from the author's device key.
2. **Given** a member whose role does not permit the action, **When** their packet arrives at a peer, **Then** the peer rejects it and does not apply it.
3. **Given** a per-object override share, **When** a Space member outside the override receives related packets, **Then** they cannot decrypt or view the object.
4. **Given** a member is removed from a Space, **When** subsequent packets are written, **Then** the removed member cannot decrypt them (key rotation).
5. **Given** a relay or server transport, **When** it stores packets, **Then** it can read only envelope metadata, never payloads.

---

### User Story 6 - Joining via Pluggable Identity (Priority: P3)

A new user or new device joins a Space. The default identity provider uses an invite link or QR code that works even offline (e.g. over Bluetooth). An App Developer can swap in a different identity provider.

**Why this priority**: Required for multi-user, but a single default provider is enough to start.

**Independent Test**: Invite a device via QR with no internet, verify it can decrypt and write to the Space; run the Identity Provider contract suite against the default provider.

**Acceptance Scenarios**:

1. **Given** an existing member, **When** they create an invite (link or QR), **Then** the invite grants a specific role in a specific Space and expires per its settings.
2. **Given** a valid invite and no internet, **When** a nearby device accepts it over a local transport, **Then** it gains the Space key and its device key is registered.
3. **Given** a user adds a second device, **When** it is linked, **Then** it gets that user's Spaces and its packets are attributed to the same user.

---

### User Story 7 - Assemble Apps From Modules (Priority: P3)

An App Developer builds an app by listing modules. Some are bundled at build time; others are loaded at runtime from a manifest. Each module registers object types (with schemas), views (custom elements), and features.

**Why this priority**: Modularity shapes the developer experience, but the sync core must exist first.

**Independent Test**: Build a sample app with one bundled module and one runtime-loaded module; verify both render views and read/write their declared types.

**Acceptance Scenarios**:

1. **Given** a module registers an object type with a schema, **When** a packet violates the schema, **Then** it is rejected locally and by peers.
2. **Given** a runtime manifest lists a module, **When** the app starts, **Then** the module loads and its views are available, and it remains available offline afterward.
3. **Given** a module declares access only to certain types/Spaces, **When** it tries to read or write outside that declaration, **Then** the access is denied.
4. **Given** a schema version bump with a migration, **When** older objects are read, **Then** they are migrated; packets from peers on the older version are still accepted.

---

### User Story 8 - Attachments via Blob Sync (Priority: P3)

An End User attaches a photo to an object. The object syncs immediately; the photo syncs separately and lazily, encrypted.

**Why this priority**: Needed in v1 but independent of the core packet pipeline.

**Independent Test**: Attach a large file on device A; verify device B sees the object at once and fetches the blob on demand; verify the stored blob is ciphertext.

**Acceptance Scenarios**:

1. **Given** an object with an attachment, **When** it syncs, **Then** the packet carries only a content-addressed blob reference, not the bytes.
2. **Given** a device views an object whose blob it lacks, **When** the blob is available on any transport, **Then** it is fetched, verified against its hash, decrypted, and shown.
3. **Given** two objects reference identical content, **When** stored, **Then** the blob is stored once per Space key.

---

### User Story 9 - History, Undo, and Compaction (Priority: P3)

The packet log supports undo and catching up peers. After a retention window, old history is compacted into snapshots so storage doesn't grow forever.

**Independent Test**: Generate a long history, run compaction, verify state is unchanged, a fresh peer can bootstrap from the snapshot, and undo works within the window.

**Acceptance Scenarios**:

1. **Given** the user makes an edit, **When** they undo within the retention window, **Then** a new compensating packet restores the prior field values.
2. **Given** history older than the retention window, **When** compaction runs, **Then** current state is identical before and after.
3. **Given** a peer that was offline longer than the retention window, **When** it reconnects, **Then** it resyncs from a snapshot plus newer packets and still converges.

---

### Edge Cases

- Device clock is badly wrong (hours or years off): ordering must still converge and not let one device "win" forever.
- A packet references an object type whose module isn't installed on this device: store and relay it, don't drop it, render nothing.
- A packet signed by a device whose membership was revoked: accept only if its clock precedes the revocation.
- Storage quota exceeded on the device (IndexedDB eviction, iOS limits).
- Two users accept the same single-use invite at the same time.
- A transport delivers a corrupted or truncated packet.
- A runtime-loaded module's source is unreachable on startup.
- A user is a member of many Spaces with large histories (initial sync size).
- A peer running an older Framework version receives a packet in a newer format.

## Requirements *(mandatory)*

### Functional Requirements

**Objects & storage**

- **FR-001**: The Framework MUST store every synced record as a Syncable Object with a globally unique ID, type, Space (and optional override share), schema version, and fields.
- **FR-002**: The Framework MUST persist all objects, the packet log, and the outbox locally so the app works with no transport.
- **FR-003**: The Framework MUST expose a reactive query API so views update automatically when matching objects change.

**Data Packets**

- **FR-004**: Every create, update, and delete MUST be represented as an immutable Data Packet with a unique ID, author device, Space, object ID, operation, clock timestamp, changed fields, and signature.
- **FR-005**: Local changes and remote changes MUST be applied through the same packet-apply path.
- **FR-006**: Packet application MUST be idempotent and order-independent (converges for any delivery order).
- **FR-007**: Concurrent field changes MUST resolve by per-field last-writer-wins, ordered by a hybrid logical clock with a deterministic tiebreaker (e.g. device ID).
- **FR-008**: Packets for unknown types or unknown future versions MUST be stored and relayed, not discarded.

**Transports**

- **FR-009**: The Framework MUST define a single Transport contract (connect, disconnect, send packets, receive packets, sync-state exchange, blob fetch) and ship a contract test suite for it.
- **FR-010**: Multiple transports MUST be able to run simultaneously; packets MUST be deduplicated by ID.
- **FR-011**: Devices MUST be able to relay packets between transports, configurable per app and per Space.
- **FR-012**: Sync MUST be resumable: peers exchange a compact summary of what they have and send only what is missing.
- **FR-013**: The Framework MUST ship two reference transports in v1: a WebSocket server transport and a Web Bluetooth peer transport. Where Web Bluetooth is unavailable (e.g. iOS/iPadOS browsers, Firefox), the Bluetooth transport MUST report itself as unsupported and the app MUST continue normally on the other transports.

**Deletes**

- **FR-014**: Deletes MUST be recorded as tombstones that sync like any packet. When a delete and an edit are concurrent, the object stays deleted (delete wins) unless the app's type schema opts into "edit resurrects". Tombstones are retained at least as long as the retention window.

**Security & Spaces**

- **FR-015**: Objects MUST belong to a Space; members share the Space key and have a role.
- **FR-016**: The Framework MUST support per-object override shares with their own member list and key.
- **FR-017**: Packet payloads and blobs MUST be encrypted on the client before leaving the device; only routing metadata is visible to transports.
- **FR-018**: Every packet MUST be signed by the author's device key; peers MUST verify signature and role before applying.
- **FR-019**: Removing a member MUST rotate the affected key(s) so that later packets are unreadable to them.
- **FR-020**: v1 MUST use exactly three fixed roles per Space or override share: Owner (manage members, roles, keys, and all objects), Editor (create, update, delete objects), and Viewer (read only). Custom roles and per-type permissions are out of scope for v1.

**Identity**

- **FR-021**: Identity MUST be provided through a pluggable Identity Provider contract with a contract test suite.
- **FR-022**: The default Identity Provider MUST support invite link and QR code joining, including fully offline joining over a local transport.
- **FR-023**: A user MUST be able to link multiple devices, each with its own device key, under one user identity.

**Modules**

- **FR-024**: Modules MUST be able to register object types (with versioned schemas and migrations), views (custom elements), features, transports, and identity providers.
- **FR-025**: Modules MUST be loadable either bundled at build time or from a runtime manifest; runtime-loaded modules MUST be cached for offline use.
- **FR-026**: Modules MUST declare which object types and Spaces they access; the Framework MUST enforce these declarations.
- **FR-027**: Packets MUST be validated against the registered schema before being applied or sent.
- **FR-028**: Runtime-loaded modules MUST be served from the app's own origin; the Framework MUST refuse to load manifest entries pointing to any other origin. Cross-origin, sandboxed, or signed third-party modules are out of scope for v1.

**Blobs**

- **FR-029**: Binary attachments MUST be stored as encrypted, content-addressed blobs referenced from objects, and synced lazily and independently of packets.
- **FR-030**: Fetched blobs MUST be verified against their hash before use.

**History**

- **FR-031**: The packet log MUST be retained for at least a configurable retention window and support undo via compensating packets.
- **FR-032**: History older than the retention window MUST be compactable into snapshots without changing state; peers MUST be able to bootstrap from a snapshot.

**App packaging**

- **FR-033**: A complete app MUST be deployable as static files and installable as a PWA, with its shell and modules available offline.

### Key Entities

- **Syncable Object**: a unit of app data. ID, type, Space/override share, schema version, fields, per-field clocks, tombstone flag.
- **Data Packet**: an immutable change record. ID, author device, Space, object ID, operation (create/update/delete), clock, changed fields (encrypted), signature.
- **Space**: a sharing boundary. Members, roles, current key epoch, settings (relay, retention).
- **Override Share**: a per-object sub-share with its own members and key.
- **Member / User / Device**: a user identity with one or more device keys; membership grants a role in a Space.
- **Transport**: a plugin that moves packets and blobs between devices.
- **Identity Provider**: a plugin that establishes users, devices, and invites.
- **Module**: a package registering types, views, features, transports, or identity providers, with declared access.
- **Object Type Schema**: fields, validation, version, migrations, merge options (e.g. delete behavior).
- **Blob**: encrypted, content-addressed binary data referenced by objects.
- **Snapshot**: compacted state of a Space at a point in the log.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of CRUD operations succeed with all transports disconnected, and survive app restart.
- **SC-002**: Local edits appear in the UI in under 50 ms on a mid-range phone.
- **SC-003**: With two devices online on the same transport, a remote edit appears in the other device's view within 1 second (p95, excluding transport latency beyond the network round trip).
- **SC-004**: In randomized partition tests (≥10,000 runs, random edits and delivery orders), 100% of runs end with identical state hashes on all peers.
- **SC-005**: 0 packets with invalid signatures or insufficient roles are applied in adversarial tests.
- **SC-006**: A server/relay transport's stored data contains no plaintext payload fields (verified by test).
- **SC-007**: A Module Author can implement a new transport that passes the contract suite without modifying core code.
- **SC-008**: A sample app with two modules deploys to a plain static host and passes a PWA installability audit.
- **SC-009**: After compaction, local storage for a Space with 100k historical packets is reduced by at least 80% with no state change.

## Assumptions

- "Delete wins" over concurrent edits by default (FR-014); change if your apps need resurrection more often.
- Relay is on by default for Spaces, so mesh setups "just work"; apps can turn it off.
- Default retention window: 30 days.
- Framework name is TBD; referred to as "the Framework".
- Browser targets: current evergreen Chrome, Edge, Firefox, Safari (including iOS), subject to per-transport API availability.
- Web Bluetooth works only in Chromium-based browsers (Chrome, Edge, Android Chrome) and requires a user gesture to pair; iOS devices sync via WebSocket only in v1.
- Offline joining over a local transport (US6, FR-022) therefore requires two Chromium-based devices in v1.

## Review & Acceptance Checklist

- [ ] No implementation details beyond constraints fixed in the constitution
- [ ] Requirements are testable and unambiguous
- [ ] Success criteria are measurable
- [x] All [NEEDS CLARIFICATION] markers resolved
- [ ] Scope is bounded (consider splitting into sub-specs: sync core, security/identity, modules, blobs)
