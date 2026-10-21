# @sync/transport-websocket

Client transport for a WebSocket relay (see `@sync/relay-server`). One peer (the server), reconnects with
exponential backoff. `createWebSocketTransport({ url })`, then `core.addTransport(...)`.
