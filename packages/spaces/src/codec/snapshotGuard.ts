/**
 * Seals snapshots with the Space key and signs them with this device (research R-11). Only a device that is
 * currently an Owner or Editor of the Space may sign a snapshot others accept; control events and
 * share-bound objects are pinned out of snapshots, so a forged snapshot cannot touch membership or shares.
 */

import { base32, canonicalBytes, parseJsonBytes, type SnapshotGuard } from '@sync/core';
import type { AuthorityView } from '../authority/hub';
import { b64urlDecodeSafe } from '../crypto/b64';
import { concat, utf8 } from '../crypto/bytes';
import { aesOpen, aesSeal, signBytes, verifySignature } from '../crypto/suite';
import { randomBytes } from '../crypto/bytes';
import type { Keystore } from '../keystore/keystore';
import { HEADER_BYTES, buildHeader, parseHeader, type KeyAccess } from './spaceCodec';

const aadOf = (space: string, header: Uint8Array) =>
  concat(utf8.encode('snapshot/1'), utf8.encode(space), header);

export function createSnapshotGuard(d: {
  keys: KeyAccess;
  keystore: Keystore;
  authorities: AuthorityView;
  settle?: () => Promise<void>;
}): SnapshotGuard {
  return {
    async seal(space, objects) {
      const wk = await d.keys.writeKey(space);
      if (!wk) throw new Error('no Space key to seal the snapshot with');
      const header = buildHeader(space, wk.epoch, wk.keyId);
      const nonce = randomBytes(12);
      const ct = await aesSeal(wk.key, nonce, canonicalBytes({ objects } as never), aadOf(space, header));
      return concat(header, nonce, ct);
    },

    async open(space, bytes) {
      const h = parseHeader(bytes);
      if (!h || h.scope !== space || bytes.byteLength < HEADER_BYTES + 12 + 16)
        return { ok: false, reason: 'malformed' };
      const key = await d.keys.readKey(h.scope, h.keyId);
      if (!key) return { ok: false, reason: 'missing-key' };
      const pt = await aesOpen(
        key,
        bytes.slice(HEADER_BYTES, HEADER_BYTES + 12),
        bytes.slice(HEADER_BYTES + 12),
        aadOf(space, bytes.slice(0, HEADER_BYTES)),
      );
      if (!pt) return { ok: false, reason: 'malformed' };
      try {
        const o = parseJsonBytes(pt) as { objects?: unknown[] };
        return Array.isArray(o.objects)
          ? { ok: true, objects: o.objects }
          : { ok: false, reason: 'malformed' };
      } catch {
        return { ok: false, reason: 'malformed' };
      }
    },

    async sign(_space, canonical) {
      const dev = d.keystore.requireDevice();
      return { signer: dev.deviceId, sig: await signBytes(dev.signPriv, canonical) };
    },

    async verify(space, signer, canonical, sig) {
      if (!signer || !sig) return { accept: false, reason: 'unsigned' };
      const auth = await d.authorities.ensure(space);
      // the packets that name the signer may have just arrived: let their background work finish first
      if (!auth.device(signer)) await d.settle?.();
      const dev = auth.device(signer);
      if (!dev) return { accept: false, reason: 'unknown signer' };
      if (dev.revoked) return { accept: false, reason: 'signer was revoked' };
      const role = auth.currentRole(dev.user);
      if (role !== 'owner' && role !== 'editor') return { accept: false, reason: 'signer may not write' };
      const pub = b64urlDecodeSafe(dev.signPub);
      if (!pub || !(await verifySignature(pub, sig, canonical)))
        return { accept: false, reason: 'bad signature' };
      return { accept: true };
    },
  };
}

void base32;
