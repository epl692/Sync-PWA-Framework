# @sync/hub-core

The logic of a Bluetooth Hub (spec 005): a persistent, access-controlled store-and-forward relay that holds **no content keys**.

- `createHub({ bridge, store })`: relay + link server + owner controls. `bridge` is a `BleBridge` (the native Bluetooth boundary).
- Stores: `createMemoryStore()`, `createSegmentStore(fsPort)` (crash-safe, day-sharded, with retention and eviction). `./node` has a Node `fs` port.
- Hub-to-Hub linking, attached transports, and blob storage (`blobs`) are options of the Hub.
- `createSidecarBridge(proc)`: the client side of the JSON-lines protocol used by the desktop sidecars.

Never imports `@sync/spaces` (enforced by lint and a test). Contracts: `specs/005-bluetooth-transport/contracts/`.
