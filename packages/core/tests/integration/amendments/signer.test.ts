// T006 (A-1): a registered PacketSigner fills `sig` over the canonical envelope with sig = null.
import { describe, expect, it } from 'vitest';
import { decodeEnvelope, encodeEnvelope, type PacketSigner } from '@sync/core';
import { createTestCore, readPacketRecords } from '@sync/testkit';

const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));

describe('A-1 PacketSigner', () => {
  it('signs the canonical envelope with sig = null and stores the result in sig', async () => {
    const seen: { space: string; author: string }[] = [];
    const signer: PacketSigner = {
      id: 'test-sig/1',
      async sign(bytes, ctx) {
        seen.push(ctx);
        return sha256(bytes);
      },
    };
    const t = await createTestCore();
    t.core.registerSigner(signer);
    await t.core.create('s1', 'item', { a: 1 });
    const rec = (await readPacketRecords(t.storage))[0]!;
    const { env } = decodeEnvelope(rec.raw);
    expect(env.sig).not.toBeNull();
    expect(env.sig).toEqual(await sha256(encodeEnvelope({ ...env, sig: null })));
    expect(seen).toEqual([{ space: 's1', author: t.core.deviceId }]);
  });

  it('leaves sig null when no signer is registered (001 behavior unchanged)', async () => {
    const t = await createTestCore();
    await t.core.create('s1', 'item', { a: 1 });
    const { env } = decodeEnvelope((await readPacketRecords(t.storage))[0]!.raw);
    expect(env.sig).toBeNull();
  });

  it('exposes the signing input to send validators (sig already present)', async () => {
    const t = await createTestCore();
    t.core.registerSigner({ id: 's', sign: async () => new Uint8Array([1, 2, 3]) });
    let sawSig: Uint8Array | null | undefined;
    t.core.registerValidator({
      id: 'v',
      phases: ['send'],
      validate: (_p, env) => {
        sawSig = env.sig;
        return { verdict: 'accept' };
      },
    });
    await t.core.create('s1', 'item', { a: 1 });
    expect(sawSig).toEqual(new Uint8Array([1, 2, 3]));
  });
});
