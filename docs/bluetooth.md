# Bluetooth sync through a Hub

Sync with people nearby when there is no network: at a campsite, an event, or during an outage. One person leaves a **Hub** running on a
phone or computer. Everyone else opens the app in a browser and connects to it over Bluetooth. The Hub stores and passes on **encrypted**
changes between everyone connected. It cannot read them.

> Status: the transport, the Hub logic, and the owner and client screens are written and tested against a simulated radio.
> The Android and desktop Hub apps (the part that talks to a real Bluetooth radio) are **not built yet**. See
> `specs/005-bluetooth-transport/validation.md`.

## What you need

| Role | What | Works on |
|---|---|---|
| Client | The app in a Chromium-based browser (Chrome, Edge) with Bluetooth on, on a secure (https) page | Android, Windows, macOS, Linux, ChromeOS. **Not** Safari, Firefox, or any iPhone or iPad browser: the app tells you and keeps working on other connections |
| Hub | The Hub app | Android 8+, Windows 10 1703+ (the Bluetooth adapter must support acting as a peripheral), macOS 12+, Linux with BlueZ 5.50+ |

Browsers cannot connect to each other over Bluetooth, which is why a Hub is needed.

## For the person running a Hub

1. Start the Hub app and allow Bluetooth when asked. On Android keep the notification (it keeps the Hub running with the screen off).
2. **Add a Space.** In the app, open the Space and choose *Let a Hub serve this Space*. It shows a **serve code**. Paste it into the Hub's
   *Spaces* screen (a QR code is not available yet). The code lets the Hub store and pass on that Space's encrypted data; it cannot read it.
3. Tell people your Hub's name, and the four words and fingerprint shown at the top. They will check them the first time.

Settings in the Hub:

- **Who can connect.** *Anyone who belongs to a Space this Hub serves* (default), or *Only devices I approve*. In approval mode the
  Devices screen shows who is waiting; approve or deny. Switching to approval never throws out a device you already approved.
- **Serve any Space a connecting device brings** (off by default). For events where you cannot collect codes first. A stranger who
  knows a Space's ID could claim it before its members do, so use it only when needed and review the list afterwards.
- **Storage.** The Hub keeps changes for 14 days by default and up to its storage limit. When full it deletes changes that other
  devices already received first, and warns you before it deletes anything nobody else has.
- **Linking Hubs.** Choose *This Hub should also join my other Hubs* when you export the code (a **link code**). Hubs you own that are
  in range then sync with each other. Only give a link code to Hubs you own: it can make a Hub join other Hubs (it still cannot read data).

## For everyone else

1. Open the app and the Bluetooth panel. Press **Find a Hub**, pick the Hub from the browser's list.
2. The first time, check the name, fingerprint and four words against what the owner shows you, then **Trust this Hub**.
   Next time it reconnects by itself where your browser allows it, or with one tap.
3. If the owner requires approval you will see "Waiting for the Hub owner". If the Hub is full it tells you and tries again.
4. Large files (over 5 MB) do not go over Bluetooth: you are told, and they download by themselves on a faster connection.

If the Hub's identity changed since you last trusted it you get a warning and nothing is shared. If you know the owner replaced the Hub,
forget the old one and connect again.

## What the Hub can and cannot see

It sees: which Spaces it serves, the device IDs and display names of connected devices, packet sizes and timing, and the routing
information every relay sees (Space ID, author device ID, clock, key epoch). It cannot see: any object, field, message, file, member
list or role. It holds no key that could. Details and the residual risks are in `specs/005-bluetooth-transport/security-review.md`.

## Developers

- Packages: `@sync/transport-bluetooth` (browser transport, link protocol, client screens), `@sync/hub-core` (Hub logic, stores, link
  server, Hub-to-Hub), `@sync/hub-ui` (owner screens). Native shells will live in `hubs/`.
- Register the transport as a module: `bluetoothModule({ options })` from `@sync/transport-bluetooth/module`, and list `bluetooth.link` in
  the app config's `transports`. Give it `spaces.hubAccess.proofs` from `@sync/spaces` as `proofs`.
- Blobs: pass `sourceFilter: bluetoothBlobFilter()` in the blob engine config so large blobs wait for a faster transport.
- Run a Hub on a simulated radio: see the integration tests in `packages/hub-core/tests/integration/`. Contracts:
  `specs/005-bluetooth-transport/contracts/`.
- Tests: `npm run test:bluetooth`, `npm run test:hub`.
