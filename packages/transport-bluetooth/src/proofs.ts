/** What the transport needs from the Spaces layer to prove membership (the Spaces layer's `hubAccess.proofs`). The transport never sees keys, only signatures. */

export interface HubProofProvider {
  /** Spaces this device can prove membership for, with the highest epoch it holds. */
  spaces(): Promise<Array<{ space: string; epoch: number }>>;
  /** Sign the Hub challenge for one Space and epoch with that epoch's derived access key. */
  proveSpace(a: { space: string; epoch: number; hubFingerprint: Uint8Array; nc: Uint8Array; nh: Uint8Array }): Promise<Uint8Array>;
  /** Sign the session binding with the device signing key. */
  proveDevice(a: { hubFingerprint: Uint8Array; nc: Uint8Array; nh: Uint8Array }): Promise<{ device: string; publicKey: Uint8Array; sig: Uint8Array; name: string }>;
  /** Access public key, used only for the optional automatic-mode claim. */
  accessPublic(space: string, epoch: number): Promise<Uint8Array>;
}
