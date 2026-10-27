# Sync PWA Framework

Offline-first, object-based sync for web apps. Every item is a **Syncable Object** stored on the device; every
change is an immutable **Data Packet**; devices converge automatically, over any **Transport** (a WebSocket relay,
direct WebRTC between two browsers, or one you write).

This repository contains the **Sync Core** (spec `001-sync-core`) and **Spaces, Security & Identity** (spec
`002-spaces-security-identity`): shared, end-to-end encrypted Spaces, signed packets that every peer verifies,
key rotation, private objects inside a Space, and invite-by-link/QR. Modules and app assembly (spec `003`) and encrypted attachments (**Blob Sync**, spec `004`: photos and files that sync lazily, on request, separately from packets; see [docs/blobs.md](docs/blobs.md)) build on them.

> **Release builds use `openSecureCore`** (from `@sync/spaces`), which registers only the encrypting codec.
> The plaintext codec used in tests and demos lives in `@sync/testkit` and is never imported by `@sync/core` or
> `@sync/spaces`; `assertSecureCore(core)` and a bundle test guard this.

## Packages

| Package | What it is |
|---|---|
| `@sync/core` | Object store, packet pipeline, convergent merge, sync protocol, history. No runtime dependencies. |
| `@sync/transport-websocket` | Client transport for a relay server. Reconnects with backoff. |
| `@sync/transport-webrtc` | Browser-to-browser data channel, paired by QR code or pasted code. No server. |
| `@sync/relay-server` | Reference relay: stores and forwards opaque packets, in memory, and (optionally) ciphertext blobs on disk as a cache. A convenience, not required. |
| `@sync/blobs` | Attachments: encrypted, chunked, content-addressed blobs that sync on request, resume, verify every chunk, dedup, and respect a storage budget. No runtime dependencies. |
| `@sync/spaces` | Spaces and roles, end-to-end encryption, signing, key rotation, override shares, the Identity Provider contract. Web Crypto only, no runtime dependencies. |
| `@sync/identity-invite` | The default Identity Provider: invite links and QR codes, device linking. |
| `@sync/testkit` | Contract suites (Transport, Storage, Identity Provider), test helpers, random convergence scenarios. Dev only. |

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

### Encrypted Spaces

```ts
import { openSecureCore } from '@sync/spaces';
import { createInviteProvider, qrToSvg } from '@sync/identity-invite';

const { core, spaces } = await openSecureCore({
  provider: createInviteProvider(),
  approveJoin: (req) => askTheUser(req),      // req.sas: five words both screens show
  approveLink: (device, sas) => askTheUser({ device, sas }),
  core: { storage: await createIndexedDbStorage({ name: 'my-app' }) },
});
core.addTransport(createWebSocketTransport({ url: 'wss://example.com/sync' }));

await spaces.signUp('Maya');
const family = await spaces.create('Family');                  // Maya is its Owner; everything in it is encrypted
await core.create(family.id, 'note', { title: 'groceries' });  // same API as before
const invite = await spaces.invite(family.id, { role: 'editor', expiresAt: Date.now() + 86_400_000, maxUses: 1 });
showQr(qrToSvg(invite.qrPayload));                             // or share invite.url; the secret is in the #fragment
// on the other device:  await spaces.accept(scannedOrPastedText)
```

Writing your own identity provider (for example an organization login): `docs/writing-an-identity-provider.md`.

## Develop

Needs Node 20+.

```bash
npm install
npm test                 # unit, contract, integration, property (500 random scenarios)
npm run test:property    # CONVERGENCE_RUNS=10000 for the release gate
npm run e2e              # real Chromium: npx playwright install chromium first
npm run relay-server     # ws://localhost:8787 (BLOB_DIR=./blobs to store attachments)
npm run test:blobs       # the blob suites; BLOB_PERF_MB=100 for the full 100 MB budgets
npm run dev -w @sync/transport-webrtc   # pairing demo on http://localhost:5174
npm run bench -w @sync/core             # compaction of 100k packets
```

Validation scenarios are in `specs/001-sync-core/quickstart.md`, `specs/002-spaces-security-identity/quickstart.md` and `specs/004-blob-sync/quickstart.md`; results in the matching `validation.md`. Browser tests in a sandbox without `playwright install`: set `PW_CHROMIUM_PATH` to an installed Chromium.

## Writing a transport

Implement the `Transport` interface (`specs/001-sync-core/contracts/transport.ts`) and run the contract suite:

```ts
import { transportContract } from '@sync/testkit';
transportContract('my transport', { create: async () => ({ transport, remote, teardown }) });
```

Passing it means your transport works in any app with no core changes. See `packages/testkit/README.md`.

## License

MIT, see [LICENSE](LICENSE).
