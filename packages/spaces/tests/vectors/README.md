# Known-answer vectors

`vectors.json` holds fixed keys, nonces and the exact bytes they produce, so another implementation of the format in
`specs/002-spaces-security-identity/contracts/crypto-envelope.md` can check itself:

- `codec`: the `aes-gcm-space/1` body for a given key, nonce, envelope fields and packet body.
- `signature`: the signing input (the canonical envelope with `sig: null`), the Ed25519 signature over it (RFC 8032 test key), and the signed envelope.
- `grant`: a key grant addressed to the RFC 7748 test key, which must unwrap to `key`.

`tests/unit/vectors.test.ts` reproduces every value byte for byte. The vectors change only with a documented format change (a new codec ID), never silently.
