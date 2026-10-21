# @sync/transport-webrtc

Browser-to-browser sync over a WebRTC data channel, paired without a server by exchanging two codes:

1. Device A: `const { code, sessionId } = await rtc.createOffer()`; show it as a QR code or text.
2. Device B: `const { code: answer } = await rtc.acceptOffer(code)`; show the answer.
3. Device A: `await rtc.acceptAnswer(sessionId, answer)`.

Codes expire (10 minutes) and work once. Failures throw `PairingError` with a code: `malformed`, `expired`,
`reused`, `mismatch`, `timeout`, `unreachable`. Nothing is left half-open.

Works offline on a shared network. Across different networks you may need STUN/TURN: pass `iceServers`.
v1 provides no relay of its own. Try it: `npm run dev -w @sync/transport-webrtc`.
