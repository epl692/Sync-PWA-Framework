# Feature Specification: Modules & App Assembly

**Feature Branch**: `003-modules-app-assembly`
**Created**: 2026-10-20
**Status**: Draft
**Depends on**: 001-sync-core (reactive queries, packet validators)
**Depended on by**: none
**Input**: User description: "The Framework must work with a static PWA. The framework should allow for views and features to be added as modules."

## Scope

The Module contract, object type schemas (validation, versions, migrations, merge options), views as Web Components, bundled and runtime-loaded modules, access declarations, and packaging an app as a static, installable PWA.

This spec plugs into spec 001 by supplying the **schema packet validator** and the "edit resurrects" merge option.

## Clarifications

### Session 2026-10-20

- Q: Language and view technology? → A: TypeScript core, views as Web Components.
- Q: How are modules added? → A: Both bundled at build time and loaded at runtime from a manifest.
- Q: How are object types defined? → A: Declared, versioned schemas.
- Q: Cross-origin runtime modules? → A: No; same origin only.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Build an App From Bundled Modules (Priority: P1)

An App Developer lists modules in a config, builds, and gets a working app. Each module registers object types and views (custom elements) that read and write objects.

**Why this priority**: This is the developer's first experience of the Framework.

**Independent Test**: Build a sample app with two bundled modules; verify both render views bound to live queries.

**Acceptance Scenarios**:

1. **Given** a config listing modules, **When** the app is built, **Then** all modules are registered at startup in dependency order.
2. **Given** a module registers a view, **When** it is placed on a page, **Then** it renders and updates as its queried objects change.
3. **Given** two modules declare the same type name or custom element name, **When** the app starts, **Then** registration fails with a clear error (names are namespaced by module ID).

---

### User Story 2 - Declared Schemas Validate Data (Priority: P1)

A Module Author declares a type with fields and validation. Invalid writes are refused locally and by peers.

**Why this priority**: Schemas protect every peer from bad data and define merge behavior.

**Independent Test**: Write valid and invalid objects locally and via injected remote packets; verify only valid ones apply.

**Acceptance Scenarios**:

1. **Given** a registered type, **When** a local write violates its schema, **Then** the write is refused with a validation error.
2. **Given** a remote packet violating the schema, **When** it arrives, **Then** it is not applied (but is still stored/relayed per spec 001 if the type version is newer than known).
3. **Given** a type schema that opts into "edit resurrects", **When** a delete and edit are concurrent, **Then** the edit restores the object.

---

### User Story 3 - Deploy as a Static PWA (Priority: P1)

An App Developer copies the build output to any static host. Users install it and it works offline from first launch after install.

**Why this priority**: Static hosting is a constitution principle.

**Independent Test**: Deploy the sample app to a plain static host; run a PWA installability audit; load offline after first visit.

**Acceptance Scenarios**:

1. **Given** the build output, **When** it is served by a plain static file host, **Then** the app loads with no server-side code.
2. **Given** the app was visited once, **When** the device goes offline, **Then** the shell and all modules load from the device.

---

### User Story 4 - Add Modules at Runtime (Priority: P2)

An App Developer drops a new module file and updates the runtime manifest on the same host. Users get the module on next launch without a rebuild.

**Independent Test**: Add a module to the manifest on the host; reload; verify it registers and works offline afterward.

**Acceptance Scenarios**:

1. **Given** a manifest lists a same-origin module, **When** the app starts online, **Then** the module loads, registers, and is cached for offline use.
2. **Given** a manifest entry pointing to another origin, **When** the app starts, **Then** the entry is refused and logged.
3. **Given** a runtime module's file is unreachable, **When** the app starts, **Then** the app starts without it (or with its cached version) and reports the failure.

---

### User Story 5 - Modules Only Touch What They Declare (Priority: P2)

A module declares which types and Spaces it reads and writes. It can't access anything else.

**Independent Test**: A module tries to query or write an undeclared type; verify denial.

**Acceptance Scenarios**:

1. **Given** a module's access declaration, **When** it queries or writes outside it, **Then** the access is denied.
2. **Given** a module, **When** it is registered, **Then** its declared access is visible to the App Developer.

---

### User Story 6 - Evolve a Schema (Priority: P3)

A Module Author ships v2 of a type with a migration. Old objects migrate; peers still on v1 keep syncing.

**Independent Test**: Mixed-version peers edit the same objects; verify no data loss and convergence.

**Acceptance Scenarios**:

1. **Given** a v2 schema with a migration, **When** v1 objects are read, **Then** they are migrated.
2. **Given** a peer on v1, **When** it receives v2 packets, **Then** it stores and relays them and keeps fields it understands.
3. **Given** a peer on v2, **When** it receives v1 packets, **Then** they are migrated and applied.

---

### Edge Cases

- Objects exist for a type whose module was removed from the app: keep them, render nothing, don't drop data.
- A runtime module is updated while the app is open.
- A module throws during registration or rendering: other modules must keep working.
- Migrations that can't be reversed while v1 peers still exist.
- Two modules depend on different versions of a shared module.

## Requirements *(mandatory)*

### Functional Requirements

**Module contract**

- **FR-001**: A Module MUST declare an ID, version, dependencies, and what it registers: object types, views, features, transports, and identity providers.
- **FR-002**: Type names and custom element names MUST be namespaced by module ID; collisions MUST fail registration.
- **FR-003**: A failure in one module MUST NOT prevent other modules from loading or running.

**Schemas**

- **FR-004**: Object types MUST be declared with versioned schemas: fields, field types, validation rules, and merge options (including "edit resurrects").
- **FR-005**: Writes and incoming packets MUST be validated against the registered schema before being applied or sent.
- **FR-006**: Schema versions MUST include migrations from the previous version; peers on different versions MUST continue to converge.

**Views & features**

- **FR-007**: Views MUST be Web Components (custom elements) that can bind to reactive queries.
- **FR-008**: Features MUST be able to subscribe to object changes and run logic without a view (e.g. reminders, derived objects).

**Loading**

- **FR-009**: Modules MUST be loadable bundled at build time or from a runtime manifest, using the same contract.
- **FR-010**: Runtime-loaded modules MUST be served from the app's own origin; other origins MUST be refused.
- **FR-011**: Runtime-loaded modules MUST be cached for offline use.

**Access control**

- **FR-012**: Modules MUST declare which object types and Spaces they access (read/write); the Framework MUST enforce these declarations.

**Packaging**

- **FR-013**: A complete app MUST build to static files (HTML/JS/CSS/web manifest/service worker) deployable on any static host and installable as a PWA.

### Key Entities

- **Module**: ID, version, dependencies, registrations, access declaration.
- **Object Type Schema**: namespaced name, version, fields, validation, merge options, migrations.
- **View**: custom element registered by a module.
- **Feature**: non-visual logic registered by a module.
- **App Config**: list of bundled modules and app settings.
- **Runtime Manifest**: same-origin list of modules loaded at startup.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A sample app with two modules deploys to a plain static host and passes a PWA installability audit.
- **SC-002**: A developer can build a new single-type module with a list view in under 30 minutes using the docs.
- **SC-003**: 100% of schema-violating writes and packets are refused in tests.
- **SC-004**: Mixed v1/v2 peers converge in 100% of randomized tests with no loss of v1 fields.
- **SC-005**: A crashing module leaves all other modules functional.

## Assumptions

- Access declarations are enforced at the Framework API level; they are not a security sandbox against hostile code, which is acceptable because runtime modules are same-origin only.
- The build tooling choice (e.g. Vite) is a /plan decision.
