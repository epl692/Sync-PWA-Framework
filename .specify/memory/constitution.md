# Object Sync Web Framework Constitution

<!--
Sync Impact Report
- Version: 0.0.0 → 1.0.0 (initial ratification)
- Principles added: I–VIII
- Sections added: Technical Constraints, Development Workflow, Governance
- Templates requiring updates: plan-template.md (Constitution Check gates) ⚠ pending
- Follow-up TODOs: TODO(FRAMEWORK_NAME): framework has no name yet
-->

## Core Principles

### I. Offline-First, Always

Every app built on the Framework MUST be fully usable with no network and no transport connected.
All reads and writes go to the local store first; sync is a background concern that never blocks the UI.
A device that has been offline for any length of time MUST be able to reconnect and converge without user action.

*Rationale:* Connectivity is a bonus, not a requirement. Apps must work in the field, in a basement, or on a Bluetooth-only mesh.

### II. Everything Is a Syncable Object

All application data (items, posts, records, settings that sync) MUST be stored as Syncable Objects: a stable globally unique ID, a declared type, a Space, and a set of fields.
There is no "side channel" data store that bypasses the object model for synced data.

*Rationale:* One uniform data model means one sync engine, one permission model, and one conflict model.

### III. Data Packets Are the Only Way State Changes

Every create, update, and delete MUST be expressed as an immutable, uniquely identified Data Packet.
Local edits produce packets; remote packets are applied through the exact same path.
Applying the same packet twice MUST have no additional effect (idempotent), and applying a set of packets in any order MUST converge to the same state (commutative via per-field last-writer-wins on a causally consistent clock).

*Rationale:* If local and remote changes share one path, offline, realtime, and multi-transport sync are the same problem.

### IV. Transport Agnostic

The core MUST NOT assume any particular transport. Transports (HTTP/WebSocket server, WebRTC, Bluetooth, LAN, file export, etc.) are plugins implementing a single Transport contract.
Multiple transports MAY run simultaneously; the core deduplicates packets by ID and MAY relay packets between transports.
No transport is trusted with plaintext or with authority.

*Rationale:* The same app should sync through a cloud server today and a Bluetooth mesh tomorrow without code changes.

### V. Zero-Trust, End-to-End Encrypted

Packet payloads and blobs MUST be encrypted on the authoring device with the Space's (or override share's) key before leaving it.
Every packet MUST be signed by the author's device key, and every receiving peer MUST verify the signature and the author's role in the Space before applying it.
Servers and relays are treated as untrusted storage and forwarding; they see only the minimum envelope metadata needed to route.

*Rationale:* Permissions that only a server can enforce don't survive a peer-to-peer transport. Signed packets make every peer an enforcer.

### VI. Modular by Construction

Views, features, object types, transports, and identity providers are all Modules registered through declared contracts.
The core MUST remain small and MUST NOT contain app-specific views or features.
Modules MUST be loadable either bundled at build time or from a runtime manifest, using the same contract.
A module MUST declare what object types and Spaces it reads and writes.

*Rationale:* Apps are assembled, not forked.

### VII. Static-Hostable

A complete app (core + modules) MUST be deployable as static files (HTML/JS/CSS/manifest/service worker) on any static host.
A backend is optional and exists only as a transport target.

*Rationale:* Cheap to host, easy to self-host, and installable as a PWA anywhere.

### VIII. Contract-Tested, Test-First

Every plugin contract (Transport, Identity Provider, Module, Storage) MUST ship a reusable contract test suite that any implementation can run.
Convergence properties (Principle III) MUST be covered by property-based / randomized ordering tests.
Tests are written and failing before implementation.

*Rationale:* A plugin ecosystem only works if "implements the contract" is testable.

## Technical Constraints

- **Language:** TypeScript (strict mode) for the core and first-party modules.
- **Views:** Native Web Components (custom elements); no UI framework is required by the core. Modules MAY use a framework internally if it is fully encapsulated in their custom elements.
- **Platform APIs:** IndexedDB for local storage, Web Crypto for encryption and signing, Service Worker for offline shell and background sync.
- **Dependencies:** The core keeps runtime dependencies to a minimum; each must be justified in the plan.
- **Schemas:** Every object type is declared with a versioned schema, including validation and migrations.
- **History:** The packet log is retained for sync and undo, and compacted into snapshots after a retention window.

## Development Workflow

- Features follow spec-kit flow: `/specify` → `/clarify` → `/plan` → `/tasks` → `/implement`.
- Specs describe WHAT and WHY; technology choices belong in `plan.md` and must pass the Constitution Check.
- Any change touching packet format, signing, encryption, or the Transport contract requires a written compatibility note (older peers must not corrupt newer data).

## Governance

This constitution supersedes other practices. Amendments require a written rationale, a version bump, and an updated Sync Impact Report.
Versioning: MAJOR for removed/redefined principles, MINOR for added principles or sections, PATCH for clarifications.
Every plan MUST include a Constitution Check against Principles I–VIII; violations must be justified in the plan's Complexity Tracking table.

**Version**: 1.0.0 | **Ratified**: 2026-10-20 | **Last Amended**: 2026-10-20
