# Quickstart: Validating the Bluetooth transport and Hubs

Prerequisites, runnable checks, and expected outcomes. Contracts: [bluetooth-link.md](./contracts/bluetooth-link.md), [hub-access.md](./contracts/hub-access.md), [hub-ble-bridge.md](./contracts/hub-ble-bridge.md), [transport-bluetooth.ts](./contracts/transport-bluetooth.ts), [hub-core.ts](./contracts/hub-core.ts). Data: [data-model.md](./data-model.md).

## 1. Automated checks (no radio needed)

```bash
npm ci
npm run typecheck
npm run test:bluetooth        # transport-bluetooth: contract suites, link vectors, property and adversarial tests through MemoryBleLink
npm run test:hub              # hub-core: store, access, admission, retention, Hub-to-Hub, convergence
npm test                      # whole repo stays green (relay-server tests must be unchanged)
```

Expected: all pass. Notable checks:

- `transportContract()` and `laneContract()` run against the Bluetooth transport through the simulator at MTU 23, 185, and 247, with 1% frame loss and with duplicates.
- Link property tests: any message split at any frame size reassembles; a lost or duplicated frame aborts only that message; replayed messages are rejected; a stream-1 flood delays stream 0 by at most 4 frames.
- Access tests: a Hub holding only the access public key cannot decrypt (spec 002 plaintext scan finds no plaintext); a stranger gets the same `not-served` for unknown and wrongly-proven Spaces.
- Store tests: kill the process mid-write, reopen, no corruption and no loss of earlier packets; retention deletes expired day shards; eviction order is delivered before undelivered.
- Convergence: three clients and two Hubs in random order, with dropouts, always converge to the same state (Principle III).

## 2. Local Hub plus two simulated clients (developer loop)

```bash
npm run hub:dev -w @sync/hub-core -- --sim      # Hub core with the simulated radio and a console owner UI
npm run dev -w @sync/transport-bluetooth        # demo page with two simulated clients
```

1. In the demo, create a Space in client A and export a **serve code**; paste it into the Hub console (`add-code <code>`).
2. Connect client A and client B to the Hub. Write on A, expect B to show the change in under 3 seconds.
3. Disconnect A, write on B, reconnect A: A receives B's change from the Hub.
4. Run `mode approval` on the Hub, connect a new client C: it shows "waiting for the Hub owner" until `approve <device>`.
5. Connect client D that is not in the Space: it receives nothing and sees only "not served".

## 3. Real-device matrix (manual, recorded in `validation.md`)

Hardware: two Android phones, two Windows or macOS or Linux laptops, one tablet, with Chromium-based browsers. Airplane mode on, Wi-Fi off, Bluetooth on.

| # | Scenario | Pass when |
|---|---|---|
| 1 | Android Hub + two phones (Chrome) | Edits cross in under 3 s (SC-002); first-use fingerprint confirmation takes under 1 minute (SC-005) |
| 2 | Desktop Hub (each OS) + two clients | Same as 1. Windows: radio without peripheral support shows the "adapter cannot act as a Hub" message |
| 3 | Walk out of range during a 1 MiB sync, return | Only missing packets move (SC-003) |
| 4 | Client A writes and leaves; client B connects 10 minutes later | B receives A's changes (SC-006) |
| 5 | Android Hub linked to desktop Hub | Clients on each converge (SC-011) |
| 6 | Hub in approval mode, then open mode | Behavior matches spec FR-015 |
| 7 | Hub app closed and reopened, Hub device rebooted | Stored packets survive; clients reconnect automatically |
| 8 | 8-hour soak: 8 clients joining and leaving | 0 lost undelivered packets (SC-009); battery recorded |
| 9 | Safari, Firefox, iOS Chrome | Transport reports `unsupported` with a clear message; app works on other transports |
| 10 | 5 MiB photo, then 20 MiB photo | 5 MiB transfers with progress; 20 MiB waits for a faster transport and says so (spec US5) |

## 4. Spikes (run first, results in `validation.md` and may adjust research)

- **S-1** Hub bridges on Windows (WinRT), macOS (CoreBluetooth), Linux (BlueZ): advertise, accept a Chrome connection, echo 10 KiB.
- **S-2** Write-size probe on Chrome Android, Chrome desktop on each OS, and two adapter families: record what `PROBE` ladder reaches.
- **S-3** Concurrent connection limit on two target Android phones and one desktop adapter.
- **S-4** `getDevices()` / `watchAdvertisements()` availability across the browsers in scope.

## 5. Expected artifacts when done

`packages/transport-bluetooth`, `packages/hub-core`, `packages/hub-ui`, `hubs/desktop`, `hubs/android`, testkit additions, updated spec 002 notes, and a filled `validation.md`.
