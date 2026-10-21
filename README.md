# Sync PWA Framework

Offline-first, object-based sync for web apps. Every item is a **Syncable Object** stored on the device; every
change is an immutable **Data Packet**; devices converge automatically, over any **Transport** (a WebSocket relay,
direct WebRTC between two browsers, or one you write).

This repository currently contains the **Sync Core** (spec `001-sync-core`). Spaces, security, identity, modules
and blob sync are specs 002 to 004.

> **Not releasable on its own.** Packet payloads are not yet encrypted or signed; that is spec 002
> (Constitution Principle V). The plaintext codec used in tests and demos lives in `@sync/testkit` and is never
> imported by `@sync/core`. A test guards this.

## Packages

| Package | What it is |
|---|---|
| `@sync/core` | Object store, packet pipeline, convergent merge, sync protocol, history. No runtime dependencies. |
| `@sync/transport-websocket` | Client transport for a relay server. Reconnects with backoff. |
| `@sync/transport-webrtc` | Browser-to-browser data channel, paired by QR code or pasted code. No server. |
| `@sync/relay-server` | Reference relay: stores and forwards opaque packets, in memory. A convenience, not required. |
| `@sync/testkit` | Contract suites (Transport, Storage), test helpers, random convergence scenarios. Dev only. |

## Quick use

```ts
import { createIndexedDbStorage, createSyncCore } from '@sync/core';
import { createWebSocketTransport } from '@sync/transport-websocket';

const core = await createSyncCore({
  storage: await createIndexedDbStorage({ name: 'my-app' }),
  codecs: [myCodec],            // spec 002 provides the encrypting one
  spaces: ['my-space'],
});
core.addTransport(createWebSocketTransport({ url: 'wss://example.com/sync' })); // optional, any number

const note = await core.create('my-space', 'note', { title: 'hello' });   // works offline
await core.update(note.id, { title: 'hello again' });
core.query({ type: 'note' }).subscribe((notes) => render(notes));          // live, local first
await core.undo(note.id);                                                  // compensating packet
```

See `specs/001-sync-core/contracts/public-api.ts` for the full API.

## Develop

Needs Node 20+.

```bash
npm install
npm test                 # unit, contract, integration, property (500 random scenarios)
npm run test:property    # CONVERGENCE_RUNS=10000 for the release gate
npm run e2e              # real Chromium: npx playwright install chromium first
npm run relay-server     # ws://localhost:8787
npm run dev -w @sync/transport-webrtc   # pairing demo on http://localhost:5174
npm run bench -w @sync/core             # compaction of 100k packets
```

Validation scenarios are in `specs/001-sync-core/quickstart.md`; results in `specs/001-sync-core/validation.md`.

## Writing a transport

Implement the `Transport` interface (`specs/001-sync-core/contracts/transport.ts`) and run the contract suite:

```ts
import { transportContract } from '@sync/testkit';
transportContract('my transport', { create: async () => ({ transport, remote, teardown }) });
```

Passing it means your transport works in any app with no core changes. See `packages/testkit/README.md`.
