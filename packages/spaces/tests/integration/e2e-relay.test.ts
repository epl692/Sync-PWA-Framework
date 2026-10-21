// T041 (SC-002): everything a relay stores or forwards for an encrypted Space is free of plaintext.
import { describe, expect, it } from 'vitest';
import { HubNetwork, createSecureNode, scanForPlaintext, waitFor, type SecureNode } from '@sync/testkit';
import { createFakeClock } from '@sync/testkit';
import { b64urlEncode } from '@sync/core';

const MARKERS = ['MRK-type-9f2', 'MRK-field-9f2', 'MRK-value-9f2', 'MRK-name-9f2', 'MRK-author-9f2'];

async function pair(net: HubNetwork) {
  const clock = createFakeClock();
  const a = await createSecureNode({ name: 'a', clock, approveJoin: () => true });
  const b = await createSecureNode({ name: 'b', clock });
  a.core.addTransport(net.transport('a'));
  b.core.addTransport(net.transport('b'));
  return { a, b, clock };
}

describe('relay sees no plaintext (SC-002)', () => {
  it('stores and forwards only ciphertext, including snapshots and channel traffic', async () => {
    const net = new HubNetwork();
    const { a, b } = await pair(net);
    const space = await a.spaces.create('MRK-name-9f2');
    const obj = await a.core.create(space.id, 'MRK-type-9f2', { 'MRK-field-9f2': 'MRK-value-9f2' });
    await a.core.update(obj.id, { note: 'MRK-value-9f2 again' });
    await waitFor(async () => net.hub.stats.packets >= 4, 5000, 'packets reach the relay');
    expect(scanForPlaintext(net.everything(), MARKERS)).toEqual([]);
    // sanity: the scanner does see markers when they are there
    expect(scanForPlaintext([new TextEncoder().encode(JSON.stringify({ x: b64urlEncode(new TextEncoder().encode('MRK-value-9f2')) }))], MARKERS)).toEqual(['MRK-value-9f2']);
    void b;
  });

  it('a second member joins through the relay, reads the data, and the relay still sees nothing', async () => {
    const net = new HubNetwork();
    const { a, b } = await pair(net);
    const space = await a.spaces.create('MRK-name-9f2');
    const obj = await a.core.create(space.id, 'MRK-type-9f2', { 'MRK-field-9f2': 'MRK-value-9f2' });
    const art = await a.spaces.invite(space.id, { role: 'editor', expiresAt: a.clock.now() + 3_600_000, maxUses: 1, approval: 'auto' });
    expect(await b.spaces.accept(art.url)).toEqual({ space: space.id, role: 'editor' });
    await waitFor(async () => (await b.core.get(obj.id)) !== undefined, 8000, 'joiner reads the object');
    expect((await b.core.get(obj.id))!.fields['MRK-field-9f2']).toBe('MRK-value-9f2');
    await b.core.create(space.id, 'MRK-type-9f2', { 'MRK-field-9f2': 'MRK-author-9f2' });
    await waitFor(async () => (await a.core.query({ type: 'MRK-type-9f2' }).once()).length === 2, 8000, 'owner reads the joiner write');
    expect(scanForPlaintext(net.everything(), MARKERS)).toEqual([]);
    expect(net.seen.some((m) => new TextDecoder().decode(m).includes('"t":"chan"'))).toBe(true); // the handshake went through the relay
  });

  it('a compacted Space bootstraps a new device from a sealed snapshot with no plaintext on the wire', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const clock = createFakeClock();
    const a = await createSecureNode({ name: 'a', clock, coreConfig: { retentionWindowMs: 30 * DAY } });
    const space = await a.spaces.create();
    for (let i = 0; i < 5; i++) await a.core.create(space.id, 'MRK-type-9f2', { 'MRK-field-9f2': `MRK-value-9f2 ${i}` });
    clock.advance(40 * DAY);
    expect((await a.core.compact()).packetsRemoved).toBeGreaterThan(0);
    const snap = await a.core.exportSnapshot(space.id);
    expect(snap!.objects).toHaveLength(5); // control events are not in it (they are pinned)
    const wire: Uint8Array[] = [];
    const c = await createSecureNode({ name: 'c', clock });
    const { MemoryNetwork } = await import('@sync/testkit');
    const mem = new MemoryNetwork();
    mem.tap((_f, _t, bytes) => wire.push(bytes));
    a.core.addTransport(mem.transport('a'));
    c.core.addTransport(mem.transport('c'));
    // c is a second device of the same user: link it so it holds the keys, then sync
    const { code, done } = await a.spaces.linkDevice();
    // the stub link handshake rides the identity channel
    mem.link('a', 'c');
    const session = await c.spaces.joinAsDevice(code);
    await done;
    expect(session.user).toBe(a.spaces.session()!.user);
    await waitFor(async () => (await c.core.query({ type: 'MRK-type-9f2' }).once()).length === 5, 10_000, 'bootstrap from snapshot');
    expect(scanForPlaintext(wire, MARKERS)).toEqual([]);
    expect(wire.some((w) => new TextDecoder().decode(w).includes('"sealed"'))).toBe(true);
  });
});

void ({} as SecureNode);
