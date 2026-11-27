# @sync/transport-bluetooth

Browser clients sync through a nearby **Hub** over Web Bluetooth (spec 005). Implements the 001 `Transport` contract; each connected Hub is one peer.

- `createBluetoothTransport({ proofs, confirmHub, ... })` (`chooseHub()` needs a user gesture)
- `./link`: the pure link/1 codec (frames, handshake, session crypto, scheduler, resync). No browser API; the Hub reuses it.
- `./client`: the client link without Web Bluetooth (a Hub uses it to link to another Hub).
- `./ui`: `<sync-bluetooth-panel>`, `<sync-hub-confirm>`, `<sync-hub-code>`.
- `./module`: `bluetoothModule()` for spec 003 apps.

User guide: `docs/bluetooth.md`. Protocol: `specs/005-bluetooth-transport/contracts/bluetooth-link.md`.
