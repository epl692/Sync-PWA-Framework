# @sync/relay-server

A reference relay. It speaks the sync protocol, stores and forwards **opaque** packets, and never decodes a
body, so it needs no keys. State is in memory: after a restart, clients resend what the relay lacks.

```bash
npm run relay-server        # ws://localhost:8787 (PORT=... to change)
```

Use `createRelayServer({ port })` from code. A convenience for testing and small deployments, not a required backend.
