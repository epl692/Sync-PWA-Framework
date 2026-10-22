# Writing an Identity Provider

An Identity Provider decides **who someone is** and **how people and devices find each other**. Everything else — signing, encryption, roles, key rotation, who may do what — belongs to the framework (`@sync/spaces`) and cannot be weakened by a provider.

The contract is `IdentityProvider` in `packages/spaces/src/identity/provider.ts`. The framework calls the provider; the provider reaches back only through the `ProviderHost` it receives in `init()`.

## What a provider does

| Method | Purpose |
|---|---|
| `init(host)` | Receive the host. Subscribe to `host.channel` here. |
| `createUser()` | Name the user this install belongs to. The default provider uses the device ID of the first device. An organization provider would use its login ID. |
| `issueBinding(session, device)` | Produce evidence that `device` belongs to the user. |
| `verifyBinding(user, device, binding, known)` | Check such evidence. **Deterministic, no I/O, never throws.** It runs inside packet validators on every peer. |
| `createInvite` / `revokeInvite` / `acceptInvite` | Carry an invitation out of band (link, QR) and run the handshake. |
| `beginLink` / `completeLink` | Add another device to the same user. |

## What the framework does for you

`ProviderHost` gives the provider:

- `channel` — opaque messages to peers (`identity/1`), over the relay online or a WebRTC link offline. Messages are never stored by the core. A provider **must seal** whatever it sends: transports and relays see the bytes.
- `device()` — this install's device. The provider can sign and agree on shared secrets with it, but never sees the private keys.
- `registerInvite` / `inviteStatus` / `admit` / `completeJoin` — the framework writes the signed `$sys.*` records, checks expiry and use limits, wraps and delivers the Space keys. The provider never touches keys or the Space log.
- `approve` / `approveLink` — ask the human.
- `secrets` / `store` — local-only storage for the provider's own state (invite secrets, replay nonces, its device binding).

## Rules that keep the system safe

1. **`verifyBinding` is a pure function.** Same inputs, same answer, always, on every peer. No clock, no randomness, no network, no calls on the host. The contract suite checks that it touches none of them.
2. **Never put a secret in the Space log.** `registerInvite` receives a hash of the invite secret; the secret stays in the artifact and in `host.secrets`.
3. **Prove possession without sending the secret** (the default provider sends `HMAC(secret, joinerKey ‖ nonce)`).
4. **Refuse replays.** Remember the nonces you accepted for an invite (in `host.secrets`) and ignore a repeat.
5. **Validate the invite spec**: at least one use, expiry in the future, and no more than 30 days away.
6. **Seal every handshake message** to the receiver's agreement key, with a distinct context per message kind so a reply cannot be replayed as a request.
7. **Stay silent when a message is not for you.** Several devices may see a broadcast; only the device that made the invite answers.

## Running the contract suite

```ts
// my-provider.contract.test.ts
import { identityProviderContract } from '@sync/testkit';
import { createMyProvider } from './my-provider';

identityProviderContract('my provider', () => createMyProvider());
```

The suite creates two simulated hosts with real keys and a message network between them, and checks everything above: bindings (valid, forged, garbage, purity), invite validation, approval, expiry, revocation, use limits, replay and tampering, timeouts, and device linking. It is the same suite the default provider and the stub provider pass.

`createStubIdentityProvider()` in `@sync/testkit` is a minimal working example (insecure on purpose: clear-text messages and a fixed binding token). Read it first; it is about 150 lines.

## Using it

```ts
const { core, spaces } = await openSecureCore({
  provider: createMyProvider(),
  approveJoin: (req) => askTheUser(req),   // shows req.sas, the short code both screens display
  core: { storage },
});
```

Nothing else changes: Spaces, signing, encryption, rotation and shares behave identically with any provider that passes the suite (tested in `packages/identity-invite/tests/integration/provider-swap.test.ts`).
