# @sync/testkit

Test helpers and the reusable contract suites. **Development only.** It contains the plaintext test
codec, which must never ship in a release (Constitution Principle V); `@sync/core` never imports this package.

## Validating a transport (SC-005)

Any Transport that passes `transportContract` works in any app with no core changes. In your own package:

```ts
import { transportContract, type RemoteEnd } from '@sync/testkit';

transportContract('my transport', {
  async create() {
    // build your transport plus a byte-level far end for it to talk to
    return { transport, remote, teardown };
  },
  // optional:
  reconnects: true,                       // your transport reconnects by itself
  afterStart: async (t) => { /* manual pairing, etc. */ },
  createUnsupported: () => myTransportInAnUnsupportedEnvironment(),
});
```

`remote` is a `RemoteEnd`: `send`, `onMessage`, `disconnect`, and optionally `reconnect` and `injectCorrupt`.
The suite checks connect/ready, byte-exact delivery both ways, many and large messages, abrupt close,
reconnect, clean stop, unsupported environments, and isolation of a corrupt message.

## Validating a storage adapter

```ts
import { storageContract } from '@sync/testkit';
storageContract('my adapter', () => new MyAdapter());
```

## Other helpers

- `createTestCore` / `createPeers`: cores on in-memory storage with a fake clock, connected by `MemoryNetwork`.
- `runScenario` / `scenarioArb`: random partition scenarios for convergence tests (fast-check).
- `MockRtc`: a stand-in for `RTCPeerConnection` used by the WebRTC transport tests.
