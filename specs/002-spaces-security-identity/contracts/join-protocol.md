# Contract: Join and Device-Link Handshake (default provider, `identity/1` channel)

Carried as opaque payloads on the core `channel('identity/1')` (see [core-amendments.md](./core-amendments.md) A-4), over any transport: the relay online, a WebRTC data channel offline. All payloads are canonical JSON; fields in `b64` are base64url. The relay and transports see ciphertext only.

## Invite artifact

URL fragment `#/join/<b64 canonical JSON>` (also rendered as QR):

```json
{ "v": 1, "inviteId": "…", "space": "…", "role": "editor",
  "expiresAt": 1790000000000, "secret": "<b64 32 B>",
  "inviter": { "device": "…", "signPub": "<b64>", "agreePub": "<b64>" },
  "route": { "relay": "wss://relay.example/ws", "webrtc": null } }
```

`secret` exists only in the artifact and on the inviting device; the Space log holds `SHA-256(secret)`.

## Messages

All are sealed to the receiver: `sealed = ECIES(receiverAgreePub, payload)` using X25519 + HKDF (`info = "sync-join/1"`) + AES-GCM. `kind` is inside the sealed payload.

| `kind` | From → To | Payload |
|---|---|---|
| `join-request` | joiner → inviter device (or any Owner device the relay reaches) | `{inviteId, space, device: {signPub, agreePub, name}, user, userBinding, nonce, proof}` where `proof = HMAC-SHA-256(secret, signPub ‖ nonce)` |
| `join-pending` | Owner → joiner | `{sas}` while waiting for human approval; `sas` is the short authentication string of the joiner key, shown on both screens |
| `join-grant` | Owner → joiner | `{space, role, controlHistoryHint, grants: [{scope, epoch, keyId, nonce, wrapped}], members: [{user, role}]}` |
| `join-deny` | Owner → joiner | `{reason: expired\|used-up\|revoked\|declined\|bad-proof}` |
| `link-offer` | new device → existing device | `{user, device: {signPub, agreePub, name}, nonce}` shown as QR/code |
| `link-accept` | existing device → new device | `{spaces: [{space, grants[]}]}` |

## Owner-side rules (inviter or any Owner device)

1. Look up the invite in the authority state: exists, not revoked, not expired (`now < expiresAt`), role matches, uses left (count of valid `member.add` for `inviteId` < `maxUses`). Else `join-deny`.
2. Check `proof` against the stored `secretHash` using the secret held locally. A device that does not hold the secret (not the creator) cannot check `proof`; the invite artifact therefore also names the **creating Owner device**; other Owner devices forward the request to it, or approve based on the invite alone when `approval = 'required'` (human check by SAS).
3. If `approval = 'required'`, show the approval UI and send `join-pending`. Timeout 5 minutes by default.
4. Write, in this order: `$sys.device` (joiner binding), `$sys.member add` with `inviteId`. If more than one epoch is granted, write the `$sys.keygrant` objects.
5. Send `join-grant`. The joiner writes nothing until it holds the keys and the control history.

## Joiner-side rules

1. Verify the inviter public key hash equals `inviter.device` (self-certifying ID) before sending anything.
2. After `join-grant`, sync the Space normally (any transport); `revalidate()` decrypts parked packets.
3. Verify `members` in the grant against the control history once it arrives; the grant is a hint only, never trusted for authority.

## Error and edge behavior

| Situation | Behavior |
|---|---|
| Expired / used-up / revoked invite | `join-deny`; no state written |
| Two joiners, one use left | Both may be granted by racing Owner devices; the fold keeps the lower clock; the other becomes inert and an Owner rotates (research R-14) |
| Bad `proof` | `join-deny: bad-proof`, no write |
| Handshake interrupted | Nothing is written until step 4; step 4 writes are individually idempotent; the joiner retries with the same artifact |
| Joiner already a member | `join-grant` is re-sent (idempotent; no second `member.add`) |
