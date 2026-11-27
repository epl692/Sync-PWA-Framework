# Contract: Hub Access (serve codes and membership proof)

How a Hub that holds no content keys decides whether a client may sync a Space. Rationale: [research.md](../research.md) R-07. Wire usage: [bluetooth-link.md](./bluetooth-link.md#control-messages).

## Access keypair

For a Space `S` at key epoch `E`, a member's app derives:

```
seed          = HKDF-SHA-256(ikm = epochKey(S, E), salt = 0x00*32,
                             info = "sync-hub-access/1" || spaceId(16 B) || epoch(4 B BE), length = 32)
accessPrivate = Ed25519 private key from seed
accessPublic  = Ed25519 public key
```

Properties required and tested:

- Domain-separated: `info` differs from every existing label in `contracts/crypto-envelope.md` (spec 002), so the access key shares nothing with encryption or wrap keys.
- One-way: neither `accessPublic` nor `accessPrivate` lets anyone derive `epochKey`, any write key, or decrypt any packet or blob.
- Deterministic: every member at epoch `E` derives the same pair.

## Serve code

Text form: `syncserve:1:` + base64url(UTF-8 JSON). Shown as a QR code and a pasteable string.

```json
{ "v": 1, "kind": "serve", "space": "<space id>", "epoch": 4,
  "accessPublic": "<base64url 32 B>", "name": "Family", "createdAt": 1764200000000 }
```

A **link code** adds `"kind": "link"` and `"accessSecret": "<base64url 32 B>"` (the access private seed). It exists only so a Hub can authenticate to another Hub as a member (spec FR-010). The UI MUST show a warning: "This code lets a Hub join other Hubs for this Space. It cannot read your data. Only give it to Hubs you own."

Neither kind contains the Space key, epoch key, write key, member list, roles, object data, or device keys. `name` is the Space's display name as the owner chose to disclose and is optional. Codes are bearer values for membership verification only; they may be shared in public places at the cost of letting others *connect* (not read), and the owner can set `expiresAt` for shorter lifetimes.

### Export (member's app)

`Spaces.exportHubCode(space, { link?: boolean, name?: boolean, expiresAt? })`, requires the caller to be a current member at their latest epoch. Shown in the app's Hub screen; the app also lists the Hubs a code was used on if the user chooses to record that locally.

### Import (Hub)

Verifies `v`, `kind`, key lengths; registers `ServedSpace` with `accessKeys: [{epoch, publicKey}]`. Importing a newer epoch for the same Space adds the key and sets `expiresAt` on older epochs (retention period). Reject: unknown `v`, wrong lengths, expired code.

## Membership proof

Challenge values come from the link handshake (`nc`, `nh`, Hub fingerprint). For each Space the client wants:

```
sig = Ed25519(accessPrivate(S, E), "sync-hub-auth/1" || hubFingerprintBytes || nc || nh || spaceId || epoch(4 B BE))
```

The client uses the **highest epoch it holds** that is likely served; it MAY include one entry per epoch (at most 2) when it does not know which epoch the Hub registered. The Hub checks, for each entry, that `(space, epoch)` has a registered unexpired public key and that the signature verifies. Binding to the Hub fingerprint and both nonces prevents replay to another Hub or another session.

## Automatic mode claim

With `autoSpaces` on, a client may send `claim: [{space, epoch, accessPublicKey}]`. The Hub registers it only if no key is registered for that Space yet (trust on first use), within caps: at most 20 auto Spaces, 25% of storage each by default. The claim must still be accompanied by a valid `sig` under the claimed key (so the claimant holds the matching private key). Auto-added Spaces appear in the owner list flagged "added automatically" and can be removed.

## Failure behavior

- Wrong signature, unknown Space, expired key, or a blocked device all return the same `rejected` entry (`not-served`). The Hub never confirms which Spaces it serves to an unproven peer.
- A removed member can still pass proofs for epochs they held until the owner imports a newer-epoch code and the old key expires. They can obtain only ciphertext; for the new epoch it is unreadable to them (spec 002). This is risk RK-2 in the plan.

## Tests

- Known-answer vectors for derivation and proof (RFC 8032 Ed25519 signatures over fixed inputs).
- Property: for random epoch keys, the derived access key never equals any other 002 derived key and cannot decrypt a generated packet.
- Adversarial: replayed proof to a second session or Hub fails; wrong epoch fails; tampered nonce fails; claim for an already registered Space fails.
