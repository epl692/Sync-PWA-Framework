# Feature Specification: Blob Sync

**Feature Branch**: `004-blob-sync`
**Created**: 2026-10-20
**Status**: Draft
**Depends on**: 001-sync-core (transports, objects), 002-spaces-security-identity (keys)
**Depended on by**: none
**Input**: User description: "Binary attachments (photos, files) in v1, as encrypted, content-addressed blobs that sync lazily and separately from packets."

## Scope

Attaching binary data to objects, encrypting and content-addressing it, transferring it over transports separately from packets (chunked and resumable), fetching on demand, deduplication, and local storage management.

## Clarifications

### Session 2026-10-20

- Q: Binary attachments in v1? → A: Yes, as separate lazy blob sync.

### Session 2026-10-27

- Q: How long should a relay or server keep a stored blob, given it only sees ciphertext and cannot tell what is referenced? → A: It is a cache: delete after a configurable idle period (default 90 days since last use), or oldest-first when over a size cap; devices re-upload what the relay lacks.
- Q: Should pinning an attachment be per device or synced across a user's devices? → A: Per device only; never synced.
- Q: If an object moves into an override share after a blob was attached, must the blob be re-encrypted for the share? → A: No; it stays readable to the Space (same as earlier packets in spec 002); apps re-attach under the share if they need it private.
- Q: Should a missing photo download automatically when its object is shown, or only on request? → A: On demand by default (the app or user asks), with an optional app-defined rule for automatic download.
- Q: What is the largest single attachment accepted by default? → A: 1 GiB, configurable up to 16 GiB.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Attach a File Without Slowing Sync (Priority: P1)

An End User attaches a photo to an object. The object syncs right away; the photo follows separately.

**Why this priority**: The core value of separate blob sync is that big files never block small updates.

**Independent Test**: Attach a large file on A; verify B sees the object immediately with a "not yet downloaded" attachment.

**Acceptance Scenarios**:

1. **Given** an object with an attachment, **When** it syncs, **Then** the packet carries only a blob reference (hash, size, type), not the bytes.
2. **Given** a blob reference whose bytes aren't local, **When** a view renders it, **Then** it shows a placeholder state with size info.
3. **Given** the user attaches a file offline, **When** they come online, **Then** the blob uploads/offers in the background.

---

### User Story 2 - Fetch, Verify, and View (Priority: P1)

A device opens an object whose photo it doesn't have. The photo is fetched from any transport that has it, verified, decrypted, and shown.

**Independent Test**: Fetch a blob over WebSocket and over Bluetooth; tamper with one chunk; verify rejection.

**Acceptance Scenarios**:

1. **Given** a missing blob available on any transport, **When** requested, **Then** it is fetched, verified against its hash, decrypted, and shown.
2. **Given** a transfer interrupted midway, **When** it resumes, **Then** only missing chunks are fetched.
3. **Given** a chunk that fails verification, **When** received, **Then** it is discarded and refetched, possibly from another peer.
4. **Given** a relay or server, **When** it stores blobs, **Then** it holds only ciphertext.

---

### User Story 3 - No Duplicate Storage (Priority: P2)

Two objects in a Space reference the same file. It's stored and transferred once.

**Independent Test**: Attach the same file to two objects; verify one stored copy and one transfer.

**Acceptance Scenarios**:

1. **Given** identical content attached twice in the same Space, **When** stored, **Then** one blob is kept.
2. **Given** a blob no longer referenced by any object (after retention), **When** cleanup runs, **Then** it is removed locally.

---

### User Story 4 - Control What's Kept on the Device (Priority: P3)

An End User on a phone with little space lets old attachments be evicted and re-downloaded when needed, but pins important ones to keep offline.

**Independent Test**: Fill a storage budget, verify least-recently-used unpinned blobs are evicted and refetched on demand.

**Acceptance Scenarios**:

1. **Given** a storage budget, **When** it is exceeded, **Then** unpinned blobs are evicted, least recently used first, never ones that are the only known copy (not yet sent to any peer).
2. **Given** a pinned blob, **When** eviction runs, **Then** it is kept.

---

### Edge Cases

- A blob's only copy is on a device that is offline or lost.
- Very large files (hundreds of MB) over Bluetooth: slow, must be resumable and cancellable.
- A Space key rotates after a blob was written: entitled members must still decrypt older blobs.
- An override-share object's blob must be unreadable to Space members outside the share. A blob attached before its object moved into the share stays readable to the Space (parity with earlier packets); the app re-attaches it under the share if it must be private.
- Storage quota hit mid-download.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Attachments MUST be stored as blobs referenced from object fields by content hash, size, and media type.
- **FR-002**: Blobs MUST be encrypted on the client with the key of the object's Space or override share (spec 002) before leaving the device.
- **FR-003**: Blobs MUST sync separately from packets and never block packet sync.
- **FR-004**: Blob transfer MUST be chunked, resumable, and verifiable per chunk and as a whole.
- **FR-005**: Blobs MUST be fetchable from any transport/peer that holds them; blob transfer MUST be carried by every Transport through the spec 001 Transport contract (a binary lane over `send`), and the reusable Transport contract suite MUST verify it.
- **FR-006**: Fetched blobs MUST be verified against their hash before use.
- **FR-007**: Identical content within the same Space/share and key epoch MUST be stored once; after a key rotation the same content attached again is stored again under a new identity.
- **FR-008**: Unreferenced blobs MUST be removed from a device after the retention window. A relay or server cannot see references, so it MUST instead treat stored blobs as a cache: remove them after a configurable idle period (default 90 days since last use) or oldest-first when over a configured size cap, and devices that still hold a blob MUST re-upload it when they find the relay lacks it.
- **FR-009**: The Framework MUST support a per-device blob storage budget with LRU eviction, pinning, and protection of not-yet-shared copies. Pins and budgets are per device and MUST NOT be synced.
- **FR-010**: Views MUST be able to observe blob state (missing, downloading with progress, available, failed).
- **FR-011**: A blob that is not on the device MUST be downloaded only when the app or user requests it, unless the app supplies a rule enabling automatic download (for example, small images); the Framework default is on demand.
- **FR-012**: The Framework MUST reject an attachment larger than the configured maximum before encrypting it (default 1 GiB, configurable up to 16 GiB), and the caller MUST be told the reason and the limit.

### Key Entities

- **Blob**: encrypted bytes, identified by a hash (the hash of its manifest of per-chunk digests, which commits to every chunk), size, media type, key epoch.
- **Manifest**: the list of per-chunk digests that fixes a blob's identity and lets any peer, including an untrusted relay, verify chunks.
- **Blob Reference**: field value pointing to a blob.
- **Chunk**: verifiable piece of a blob used for transfer.
- **Blob State**: per-device status (missing, downloading with progress, available, failed), plus device-local flags (pinned; evicted, shown as missing).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An object with a 100 MB attachment appears on another online device as fast as one without (within SC-003 of spec 001).
- **SC-002**: 100% of tampered chunks are rejected in tests.
- **SC-003**: Relay/server-stored blobs contain no plaintext (automated check).
- **SC-004**: An interrupted 100 MB transfer resumes without re-sending completed chunks.

## Assumptions

- Dedup is per Space/share and key epoch (not across Spaces or across a key rotation), since content is encrypted with different keys.
- Devices delete unreferenced blobs after 30 days by default (the spec 001 history window); an attachment never referenced by any object counts as unreferenced after 24 hours.
- Default per-device blob budget is set by the app; the Framework default is "no eviction" unless configured.
- Blob storage on the reference relay server is included, with no size limit enforcement in v1 beyond configuration; relay-held blobs are a cache, and devices remain the source of truth.
