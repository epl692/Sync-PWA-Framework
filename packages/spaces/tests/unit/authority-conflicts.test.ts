// T029: concurrent membership changes resolve deterministically (FR-005, spec Edge Cases).
import { describe, expect, it } from 'vitest';
import { Authority } from '../../src/authority/authority';
import { SPACE, addMember, basicSpace, device, genesis, removeMember, resetSeqs, setRole } from '../helpers';

describe('conflicting membership changes', () => {
  function twoOwners() {
    const { auth, events } = basicSpace();
    const promote = setRole('A', 8, 'B', 'owner');
    auth.add(promote);
    return { auth, events: [...events, promote] };
  }

  it('A removes B at clock 5, B removes A at clock 6: A is the only Owner on every peer', () => {
    const { auth, events } = twoOwners();
    const aRemovesB = removeMember('A', 20, 'B', { B: 50 });
    const bRemovesA = removeMember('B', 21, 'A', { A: 50 });
    for (const order of [
      [aRemovesB, bRemovesA],
      [bRemovesA, aRemovesB],
    ]) {
      const peer = new Authority(SPACE);
      for (const e of [...events, ...order]) peer.add(e);
      expect(peer.currentRole('A')).toBe('owner');
      expect(peer.currentRole('B')).toBeNull();
      expect(peer.ownerCount()).toBe(1);
      expect(peer.state.inert.map((i) => `${i.author}:${i.reason}`)).toEqual(['B:author-revoked']);
      expect(peer.stateDigest()).toBe(
        (() => {
          const ref = new Authority(SPACE);
          ref.load([...events, aRemovesB, bRemovesA]);
          return ref.stateDigest();
        })(),
      );
    }
    void auth;
  });

  it('two Owners demote each other: the earlier change wins, the later is inert', () => {
    const { events } = twoOwners();
    const first = setRole('A', 20, 'B', 'viewer');
    const second = setRole('B', 21, 'A', 'viewer');
    const peer = new Authority(SPACE);
    peer.load([...events, second, first]);
    expect(peer.currentRole('B')).toBe('viewer');
    expect(peer.currentRole('A')).toBe('owner');
    expect(peer.state.inert).toHaveLength(1);
    expect(peer.state.inert[0]).toMatchObject({ author: 'B', reason: 'owner-required' });
    expect(peer.state.inert[0]!.event).toBe(second.id);
  });

  it('a late-arriving earlier event is reported as retroactive, with the events it made inert', () => {
    const { events } = twoOwners();
    const aRemovesB = removeMember('A', 20, 'B', { B: 50 });
    const bRemovesA = removeMember('B', 21, 'A', { A: 50 });
    const peer = new Authority(SPACE);
    for (const e of [...events, bRemovesA]) peer.add(e); // B's removal of A arrives first and takes effect
    expect(peer.currentRole('A')).toBeNull();
    const r = peer.add(aRemovesB); // A's earlier removal arrives late
    expect(r.retroactive).toBe(true);
    expect(r.newInert.map((i) => [i.event, i.reason])).toEqual([[bRemovesA.id, 'author-revoked']]);
    expect(peer.currentRole('A')).toBe('owner');
    expect(peer.currentRole('B')).toBeNull();
  });

  it('an in-order event is not retroactive and reports no new inert events when it takes effect', () => {
    const { auth } = basicSpace();
    const r = auth.add(addMember('A', 10, 'E', 'viewer'));
    expect(r).toEqual({ added: true, retroactive: false, newInert: [] });
  });

  it('a removal and a concurrent role change for the same member: the earlier clock decides', () => {
    const { events } = basicSpace();
    const promote = setRole('A', 20, 'B', 'owner');
    const remove = removeMember('A', 21, 'B', { B: 10 });
    const p1 = new Authority(SPACE);
    p1.load([...events, promote, remove]);
    expect(p1.currentRole('B')).toBeNull();
    const p2 = new Authority(SPACE);
    p2.load([...events, remove, promote]);
    expect(p2.stateDigest()).toBe(p1.stateDigest());
    expect(p2.state.inert.map((i) => i.reason)).toEqual([]);
  });

  it('an event by a device that the replay does not know yet is inert, then takes effect when the device is added earlier', () => {
    resetSeqs();
    const g = genesis('A', 1);
    const evB = addMember('B', 5, 'X', 'viewer'); // B is not known yet
    const dev = device('A', 2, 'B', 'B');
    const mem = addMember('A', 3, 'B', 'owner');
    const p = new Authority(SPACE);
    p.load([g, evB, dev, mem]);
    expect(p.currentRole('X')).toBe('viewer');
    const q = new Authority(SPACE);
    q.load([g, evB]);
    expect(q.state.inert[0]!.reason).toBe('unknown-author');
  });
});
