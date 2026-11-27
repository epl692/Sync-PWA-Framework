# Implementation Plan: Bluetooth Local Transport

**Branch**: `005-bluetooth-transport` | **Date**: 2026-11-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-bluetooth-transport/spec.md`

## Summary

Let nearby devices sync with no network by connecting browser apps to a **Hub** over Bluetooth. Browsers can only be Bluetooth clients, so the Hub (an Android or desktop app left running in the area) is the Bluetooth server: it advertises one service, accepts clients, stores and forwards **encrypted** packets and blobs for the Spaces it serves, and syncs with other Hubs. It never holds content keys.

Technical approach (details in [research.md](./research.md)):

- **Roles (R-01, R-02)**: browser = Web Bluetooth central; Hub = GATT peripheral with one service (`INFO` read, `TX` write, `RX` notify).
- **Link layer (R-03 to R-06)**: negotiated frame size (the browser cannot see the MTU, so it probes), two streams (packets and the 004 binary lane) with windowed flow control and sequence-gap detection, and message-level AES-GCM after an X25519 handshake signed by the Hub's key so radio eavesdroppers see no envelope metadata and Hubs cannot be impersonated.
- **Membership without keys (R-07)**: each Space epoch derives a separate Ed25519 **access key**; the Hub holds only the public key (from a keyless *serve code*) and verifies a signed challenge. It can verify, never decrypt.
- **Hub = RelayHub + persistence + admission (R-08, R-10)**: reuse the tested relay (summaries, resume, dedup, blob lane) in a new shared `@sync/hub-core`; add a crash-safe day-sharded packet store (14-day retention), an `admit` gate, caps, and owner controls.
- **Two native shells, one codebase (R-09)**: Android (Capacitor + Kotlin BLE plugin + foreground service) and desktop (Electron + per-OS BLE sidecars: WinRT, CoreBluetooth, BlueZ) over a single `BleBridge` contract with a shared contract suite.
- **Burst-friendly capacity (R-11)**: connections are short; extra clients get `busy` with a retry hint; store-and-forward makes the end state the same.
- **Hub-to-Hub (R-14)**: a Hub holding a *link code* acts as a central to another Hub with the same handshake and sync.
- **Radio-free testing (R-15)**: a deterministic GATT simulator in the testkit runs the existing `Transport` and lane contract suites plus loss, MTU, and reconnect scenarios; hardware matrix and spikes are listed in [quickstart.md](./quickstart.md).
- **Additive amendments (S-2, R-2, T-2)** to spaces, relay-server, and testkit; no change to packets, signing, the sync protocol, the lane, or the `Transport` contract ([contracts/amendments.md](./contracts/amendments.md)).

## Technical Context

**Language/Version**: TypeScript 5.x strict, ES2022 for all shared and browser code; Node 20 for hub-core tests and the Electron main process. Kotlin (Android plugin), Swift (macOS sidecar), C# on .NET 8 with WinRT (Windows sidecar). The sidecars and plugin are thin: they implement `BleBridge` and contain no sync, crypto, or access logic.

**Primary Dependencies**:
- `packages/transport-bluetooth` (`@sync/transport-bluetooth`): **none at runtime** beyond `@sync/core`; uses Web Bluetooth and Web Crypto (X25519, Ed25519, HKDF, AES-GCM, all available in Chromium). Dev: `@types/web-bluetooth`.
- `packages/hub-core` (`@sync/hub-core`): `@sync/core`, `@sync/blobs`, and the pure link codec and session crypto from `@sync/transport-bluetooth/link` (workspace; no Web Bluetooth code). **No third-party runtime dependency** in the library, and it never imports `@sync/spaces` (the Hub holds no content keys).
- `packages/hub-ui` (`@sync/hub-ui`): native Web Components, no framework.
- `hubs/desktop`: Electron, `dbus-next` (Linux BlueZ), sidecar executables. `hubs/android`: Capacitor 6+, Android Gradle build. These are applications, not libraries, so their dependencies do not affect the core (Constitution Technical Constraints: core keeps runtime dependencies minimal).
- Dev/test: existing `vitest`, `fast-check`, `fake-indexeddb`, `@playwright/test`.

**Storage**: Client: IndexedDB `sync-bluetooth-v1` (pinned Hubs only). Hub: day-sharded append-only segment files plus a small index per Space (packets), `createFileBlobStorage` (blobs), a settings/clients/Spaces file (JSON, atomic replace). The Hub key is stored in the platform keystore where available (Android Keystore, macOS Keychain, Windows DPAPI, Linux Secret Service) with an encrypted-file fallback. Hub stores ciphertext and envelope metadata only.

**Testing**: Vitest unit, contract, integration, property (fast-check), adversarial. `MemoryBleLink` simulator. New testkit suites `bleBridgeContract()` and `hubStoreContract()`; the existing `transportContract()` and `laneContract()` run against the Bluetooth transport. Known-answer vectors for frames, handshake, and access proofs. Playwright (Chromium) runs the demo with the simulated Bluetooth. Real radios: manual matrix in [quickstart.md](./quickstart.md).

**Target Platform**: Clients: Chromium-based browsers with Web Bluetooth on Android, Windows, macOS, Linux, ChromeOS (secure context required). Hubs: Android 8+ (foreground service), Windows 10 1703+, macOS 12+, Linux with BlueZ 5.50+. iOS and iPadOS are out of scope.

**Project Type**: Library monorepo (three new packages, additive amendments to three) plus two native application shells under `hubs/`.

**Performance Goals** ([research.md](./research.md#r-17-performance-goals), measured, shortfalls recorded in `validation.md`): 1,000-object Space first sync under 2 minutes at 20 KB/s and under 30 s at 100 KB/s; edit appears on another client p95 under 3 s (SC-002); packet latency p95 during a blob stream at most 2x idle; resume re-sends 0 delivered packets (SC-003); link CPU overhead on a phone Hub under 5% average while serving 5 clients.

**Constraints**: Offline-first: nothing here may be required for the app to work, and the transport reports `unsupported`/`unavailable` cleanly (FR-004, SC-008). Hub holds no content keys (FR-011, SC-004). Message size at most 512 KiB reassembled; frames 20 to 244 bytes. Realistic throughput 10 to 100 KB/s; blob auto-transfer ceiling 5 MiB per blob (R-05). Concurrent clients per Hub default to min(7, platform limit). Plaintext content never leaves the authoring device.

**Scale/Scope**: Groups of about 2 to 8 clients per Hub, a few Hubs per group, up to dozens of Spaces per Hub, Hub stores up to 1 GiB by default.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How the plan satisfies it |
|---|---|---|
| I. Offline-first | PASS | Bluetooth is optional and additive. All reads and writes stay local; the outbox holds changes whenever no Hub is reachable; transport failure never blocks the UI (FR-004, SC-008). This feature exists to extend offline-first to groups with no network |
| II. Everything is a Syncable Object | PASS | No new synced data. The Hub stores Data Packets and blobs as opaque items; settings, clients, and trust records are local device state, not app data |
| III. Packets are the only way state changes | PASS | Hubs store and forward packets byte for byte (never re-encoded) and apply nothing; clients apply through the normal path. Convergence property tests include Hubs, dropouts, and random order |
| IV. Transport agnostic | PASS | Implements the 001 `Transport` contract unchanged and runs alongside other transports with dedup and relay. The core learns nothing about Bluetooth. The Hub reuses the core relay behavior |
| V. Zero-trust, E2E | PASS | Packets stay encrypted and signed end to end. Hub is an untrusted relay with no content keys; membership proof uses a derived, one-way, domain-separated key (R-07). The link adds its own encryption so envelope metadata is hidden from radio eavesdroppers (R-06). Residual risks recorded below |
| VI. Modular | PASS | Transport is a registrable module with no object types. Hub is a separate application, not core. Core changes limited to the additive `admit` and store hooks in the relay |
| VII. Static-hostable | PASS (justified, see Complexity Tracking) | The PWA stays fully static-hostable and works with no Hub. The Hub app is an optional, separate native artifact that is a transport target, exactly like the relay server |
| VIII. Contract-tested, test-first | PASS | `bleBridgeContract()`, `hubStoreContract()`, the existing transport and lane suites, known-answer vectors, property and adversarial tests. Tasks put each test before its implementation |

**Technical constraints**: TypeScript strict for the transport, hub-core, and UI; Web Components for Hub UI; Web Crypto and IndexedDB on the client; zero runtime dependencies for the libraries. Native code appears only where the platform leaves no alternative (BLE peripheral role) and is kept free of logic.

**Compatibility note (required by Development Workflow):** No change to packet format, signing, encryption of packets, the sync protocol messages, the binary lane, or the `Transport` contract. New surfaces: the link protocol (own version range and service UUID), the access-key derivation label, and Hub serve/link codes. Rules for older peers are in [contracts/bluetooth-link.md](./contracts/bluetooth-link.md#compatibility), [contracts/hub-access.md](./contracts/hub-access.md), and [contracts/amendments.md](./contracts/amendments.md#overall-compatibility-summary-required-by-development-workflow).

**Post-design re-check (after Phase 1):** PASS. Items examined and justified rather than waived:

1. *Native code outside the TypeScript monorepo.* Required by the platform: browsers and Node cannot act as a BLE peripheral on Windows and macOS. Kept to bridges that hold no logic (Complexity Tracking).
2. *Hub persists data* (the relay was in-memory). Required by the spec: a Hub can be the only holder. Persistence holds ciphertext and metadata only, is crash-safe, and is bounded by retention and caps.
3. *A key held by the Hub (the link-code access secret).* It is not a content key, cannot decrypt, and exists only to let one Hub prove membership to another; it is excluded from the default code, warned about in the UI, and covered by tests. Spec FR-030 was reworded from "no keys" to "no content keys" to match.
4. *Hub open mode lets any member connect.* Accepted by the spec owner (clarification 2026-11-27); data exposed is ciphertext the member may already hold.
5. *Automatic Space mode is trust-on-first-use* and can be squatted (RK-3); bounded by caps, owner visibility, and approval mode.
6. *Capacity is bounded by radios, not by software.* Default 7 concurrent clients; the spec's "at least 8" was reworded to rely on short connections plus store-and-forward (R-11).

### Risks

| ID | Risk | Mitigation |
|---|---|---|
| RK-1 | Windows or desktop radios may not support the peripheral role | Detect and report clearly (`peripheral-role-unsupported`); spike S-1 first; Android Hub is the fallback for such groups |
| RK-2 | Removed member keeps access-key proofs until the owner re-imports the new epoch's code | They obtain only ciphertext unreadable for new epochs; app prompts to update codes; key expiry by retention; O-1 tracks automatic renewal |
| RK-3 | First-claim squatting of a Space ID in automatic mode | Caps, removable auto-Spaces list, approval mode, owner-added codes take precedence |
| RK-4 | Web Bluetooth write limits and `getDevices()` support vary | Probing and halving fallback (R-03); chooser fallback (R-13); spikes S-2 and S-4 |
| RK-5 | Throughput limits large content | Blob ceiling and wait-for-faster-transport message (R-05) |
| RK-6 | Platform kills background Hub | Foreground service, keep-awake option, first-run guidance (R-12); documented limits |
| RK-7 | Rogue Hub spoofing a known name | Hub key pinned after first confirmation; mismatch blocks until confirmed (data-model `TrustedHubRecord`) |

## Project Structure

### Documentation (this feature)

```text
specs/005-bluetooth-transport/
├── plan.md              # This file
├── research.md          # Phase 0: decisions, rationale, alternatives, spikes
├── data-model.md        # Phase 1: entities, state transitions
├── quickstart.md        # Phase 1: validation guide, spikes, hardware matrix
├── contracts/
│   ├── bluetooth-link.md      # GATT layout, frames, handshake, control messages
│   ├── hub-access.md          # Access key derivation, serve and link codes, proofs
│   ├── hub-ble-bridge.md      # BleBridge interface, sidecar protocol, platform notes
│   ├── transport-bluetooth.ts # Browser transport public API
│   ├── hub-core.ts            # Hub control surface and HubStore
│   └── amendments.md          # S-2, R-2, T-2 and the compatibility summary
├── checklists/requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks) - NOT created by /speckit-plan
```

### Source Code (repository root)

```text
packages/
├── transport-bluetooth/            # NEW: browser Transport (Web Bluetooth central)
│   ├── src/{index.ts, link/{frames,session,handshake,scheduler}.ts, webBluetooth.ts, trustStore.ts, status.ts}
│   └── tests/{contract.test.ts, link/*.test.ts, property/*.test.ts, adversarial/*.test.ts}
├── hub-core/                       # NEW: shared Hub logic (extracted RelayHub + store + access + link server)
│   ├── src/{hub.ts, relay/relayHub.ts, link/server.ts, access/{derive,codes,verify}.ts, store/{segmentStore,memoryStore}.ts, retention.ts, hubToHub.ts}
│   └── tests/{store.contract.test.ts, access/*.test.ts, admission.test.ts, retention.test.ts, hub-to-hub.test.ts, property/*.test.ts}
├── hub-ui/                         # NEW: owner screens as Web Components (clients, Spaces, mode, storage)
│   └── src/ , tests/
├── relay-server/                   # CHANGED (R-2): re-exports RelayHub from hub-core, adds store/admit hooks
├── spaces/                         # CHANGED (S-2): deriveHubAccess, exportHubCode, proveHubChallenge
└── testkit/                        # CHANGED (T-2): MemoryBleLink, bleBridgeContract, hubStoreContract

hubs/                               # NEW: native shells, built outside the npm workspaces
├── desktop/                        # Electron shell, per-OS BLE bridges
│   ├── src/ (main, tray, bridge selection, dbus-next BlueZ bridge)
│   ├── sidecar-windows/            # C# WinRT: GattServiceProvider, advertisement watcher
│   └── sidecar-macos/              # Swift: CBPeripheralManager, CBCentralManager
└── android/                        # Capacitor app
    ├── src/ (web shell that loads hub-core + hub-ui)
    └── android/ (Kotlin plugin: GATT server, advertiser, central, foreground service)

specs/005-bluetooth-transport/      # docs above
```

**Structure Decision**: Libraries and shared Hub logic live in `packages/*` (workspaces, TypeScript, tested in CI without radios). Native shells live in `hubs/*`, outside the workspaces, because they need platform toolchains (Gradle, Xcode, .NET) and heavyweight dependencies that must not enter the library dependency graph. The only coupling is the `BleBridge` contract and its shared test suite.

### Implementation phases (inputs to `/speckit-tasks`)

| Phase | Outcome | Gate |
|---|---|---|
| A. Spikes | S-1 to S-4 done; research updated if a spike contradicts an assumption | Findings in `validation.md`; go or adjust for desktop OSes |
| B. Link and transport | Frames, handshake, scheduler, `transport-bluetooth`, `MemoryBleLink`; `transportContract` and `laneContract` pass; property and adversarial tests | Passes with no radio (US1 client side, US3) |
| C. Hub core | `@sync/hub-core` with `HubStore`, access, admission, retention, caps, owner API; relay amendments; spaces amendment S-2 | Two simulated clients and a Hub converge; crash and retention tests (US1, US2, US4 core) |
| D. Native shells | Android Hub, then desktop Hub (Linux, macOS, Windows per S-1); `bleBridgeContract` per bridge; Hub UI | Real-device matrix rows 1 to 4, 6 and 7 |
| E. Hub-to-Hub and blobs | Link codes, central role in bridges, Hub-to-Hub sync, blob ceiling and progress | Matrix rows 5 and 10; US4 scenario 3, US5 |
| F. Hardening | Soak, adversarial radio-level tests, security review (`security-review.md`), docs, validation record | Matrix rows 8 and 9; SC-001 to SC-011 evidence |

User-story coverage: US1 and US2 = B + C + D; US3 = B + C; US4 = C + E; US5 = E.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Native code (Kotlin, Swift, C#) in a TypeScript repository (Principle VII spirit: static, web-only) | A BLE peripheral cannot be created from a browser or from portable Node on Windows and macOS; the Hub must be one | A browser-only Hub cannot advertise. `bleno` needs raw HCI access and a driver swap on Windows, unusable for end users. Native code is limited to bridges with no logic |
| Hub persists data (the existing relay is in-memory) | Spec FR-007 and FR-009: the Hub may be the only holder of a packet for days | In-memory would lose all data on reboot, and authors may be gone |
| Separate `hubs/` tree outside the workspaces | Native toolchains and Electron/Capacitor dependencies | Putting them in `packages/*` would pull heavy dependencies and platform toolchains into every `npm ci` and into library tests |
| Link-level encryption on top of E2E | Hide envelope metadata from radio eavesdroppers; authenticate the Hub (R-06) | Relying on E2E alone leaks Space IDs, author IDs, and clocks to anyone with a sniffer in range |
