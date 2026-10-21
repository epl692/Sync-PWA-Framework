// T049 (User Story 2, scenario 4): rejected packets are counted, reported with a reason, and never forwarded.
import { describe, expect, it } from 'vitest';
import { type CoreEvent } from '@sync/core';
import { readPacketRecords, waitFor } from '@sync/testkit';
import { SYS } from '../../src/authority/types';
import type { SecurityEvent } from '../../src';
import { Forger } from '../forger';
import { buildFamily, settle } from '../family';

describe('rejections are counted, reported and not forwarded', () => {
  it('reports each reason, counts them, and keeps them off the wire', async () => {
    const f = await buildFamily();
    const seen: SecurityEvent[] = [];
    f.owner.spaces.on((e) => seen.push(e));
    const e = await Forger.of(f.editor);
    const v = await Forger.of(f.viewer);
    const o = await Forger.of(f.owner);
    const attacks: Array<[string, { raw: Uint8Array; env: { id: string } }]> = [
      ['role', await v.packet(f.space.id, v.body('a1', {}))],
      ['bad-signature', await e.packet(f.space.id, e.body('a2', {}), { sign: false })],
      ['immutable-control', await o.packet(f.space.id, { ...o.body(SYS.inviteRevoke, {}, (await f.owner.core.query({ type: SYS.member }).once())[0]!.id), op: 'update' })],
    ];
    for (const [, p] of attacks) await f.owner.core.ingest(p.raw, 'memory:attacker');
    await settle(f.g);
    const reasons = seen.filter((x): x is Extract<SecurityEvent, { kind: 'packet:rejected' }> => x.kind === 'packet:rejected').map((x) => x.reason);
    expect(reasons).toEqual(expect.arrayContaining(['role', 'bad-signature', 'immutable-control']));
    expect(await f.owner.spaces.rejectedCount(f.space.id)).toBeGreaterThanOrEqual(3);
    for (const [, p] of attacks) {
      expect((await readPacketRecords(f.obs.storage)).some((r) => r.id === p.env.id)).toBe(false);
      expect((await readPacketRecords(f.editor.storage)).some((r) => r.id === p.env.id)).toBe(false);
    }
    await f.g.close();
  });

  it('reports a removed member’s packets as revoked or beyond the cutoff', async () => {
    const f = await buildFamily();
    const editorUser = f.editor.spaces.session()!.user;
    const e = await Forger.of(f.editor);
    // a packet the Owner had not seen when it removed the Editor
    await f.owner.spaces.remove(f.space.id, editorUser);
    await settle(f.g);
    const events: CoreEvent[] = [];
    f.owner.core.on((x) => events.push(x));
    const late = await e.packet(f.space.id, e.body('late', { n: 1 }), { seq: (await e.nextSeq(f.space.id)) + 10 });
    const r = await f.owner.core.ingest(late.raw, 'memory:editor');
    expect(r).toMatchObject({ status: 'rejected' });
    expect((r as { reason: string }).reason).toMatch(/revoked|beyond-cutoff/);
    // an old sequence number with a clock before the removal is still beyond what the Owner had seen? no: it is a duplicate id
    await waitFor(async () => !(await f.obs.core.query({ type: 'late' }).once()).length, 2000, 'never reaches the observer');
    await f.g.close();
  });
});
