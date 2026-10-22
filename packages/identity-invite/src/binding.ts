/**
 * Device bindings for the default provider: evidence that a device belongs to a user, verifiable by anyone
 * from the evidence alone (no lookup, no clock, no network), so it can run inside packet validators.
 *
 *   genesis/1  the user's first device: user === deviceId, and the device signs its own keys.
 *   chain/1    every later device: a chain of signatures from the first device to this one.
 *
 * A user ID is the device ID of the first device, so the chain's root is self-certifying.
 */

import { b64urlDecode, b64urlEncode } from '@sync/core';
import {
  concat,
  deviceIdFromSignPub,
  equalBytes,
  utf8,
  verifySignature,
  type DeviceBinding,
  type DevicePublic,
  type LocalDevice,
} from '@sync/spaces';

export const GENESIS_KIND = 'genesis/1';
export const CHAIN_KIND = 'chain/1';
const MAX_CHAIN = 10;

export interface ChainLink {
  id: string;
  signPub: string;
  agreePub: string;
  issuer: string;
  sig: string;
}

export interface Chain {
  root: { signPub: string; agreePub: string };
  links: ChainLink[];
}

const genesisMessage = (user: string, id: string, signPub: Uint8Array, agreePub: Uint8Array) =>
  concat(
    utf8.encode('sync-binding/genesis/1|'),
    utf8.encode(user),
    utf8.encode('|'),
    utf8.encode(id),
    signPub,
    agreePub,
  );

const linkMessage = (user: string, issuer: string, id: string, signPub: Uint8Array, agreePub: Uint8Array) =>
  concat(
    utf8.encode('sync-binding/link/1|'),
    utf8.encode(user),
    utf8.encode('|'),
    utf8.encode(issuer),
    utf8.encode('|'),
    utf8.encode(id),
    signPub,
    agreePub,
  );

export async function issueGenesis(me: LocalDevice): Promise<DeviceBinding> {
  return {
    kind: GENESIS_KIND,
    proof: await me.sign(genesisMessage(me.deviceId, me.deviceId, me.signPub, me.agreePub)),
  };
}

export const chainBinding = (c: Chain): DeviceBinding => ({
  kind: CHAIN_KIND,
  proof: utf8.encode(JSON.stringify(c)),
});

export function parseChain(binding: DeviceBinding): Chain | undefined {
  if (binding.kind !== CHAIN_KIND) return undefined;
  try {
    const c = JSON.parse(new TextDecoder().decode(binding.proof)) as Chain;
    return Array.isArray(c.links) && typeof c.root?.signPub === 'string' ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Add `device` to the chain of `me` (who is already bound, as a first device or through `own`). */
export async function extendChain(
  user: string,
  me: LocalDevice,
  own: Chain | undefined,
  device: DevicePublic,
): Promise<Chain> {
  const base: Chain = own ?? {
    root: { signPub: b64urlEncode(me.signPub), agreePub: b64urlEncode(me.agreePub) },
    links: [],
  };
  const sig = await me.sign(linkMessage(user, me.deviceId, device.deviceId, device.signPub, device.agreePub));
  return {
    root: base.root,
    links: [
      ...base.links,
      {
        id: device.deviceId,
        signPub: b64urlEncode(device.signPub),
        agreePub: b64urlEncode(device.agreePub),
        issuer: me.deviceId,
        sig: b64urlEncode(sig),
      },
    ],
  };
}

/** Total: any malformed or unverifiable input is simply false. */
export async function verifyDeviceBinding(
  user: string,
  device: DevicePublic,
  binding: DeviceBinding,
): Promise<boolean> {
  try {
    if (binding.kind === GENESIS_KIND) {
      return (
        user === device.deviceId &&
        (await deviceIdFromSignPub(device.signPub)) === device.deviceId &&
        (await verifySignature(
          device.signPub,
          binding.proof,
          genesisMessage(user, device.deviceId, device.signPub, device.agreePub),
        ))
      );
    }
    const chain = parseChain(binding);
    if (!chain || chain.links.length < 1 || chain.links.length > MAX_CHAIN) return false;
    const rootPub = b64urlDecode(chain.root.signPub);
    if ((await deviceIdFromSignPub(rootPub)) !== user) return false; // the root must be the user's first device
    let issuerId = user;
    let issuerPub = rootPub;
    for (const l of chain.links) {
      const signPub = b64urlDecode(l.signPub);
      const agreePub = b64urlDecode(l.agreePub);
      if (l.issuer !== issuerId || (await deviceIdFromSignPub(signPub)) !== l.id) return false;
      if (
        !(await verifySignature(
          issuerPub,
          b64urlDecode(l.sig),
          linkMessage(user, l.issuer, l.id, signPub, agreePub),
        ))
      )
        return false;
      issuerId = l.id;
      issuerPub = signPub;
    }
    const last = chain.links[chain.links.length - 1]!;
    return (
      last.id === device.deviceId &&
      equalBytes(b64urlDecode(last.signPub), device.signPub) &&
      equalBytes(b64urlDecode(last.agreePub), device.agreePub)
    );
  } catch {
    return false;
  }
}
