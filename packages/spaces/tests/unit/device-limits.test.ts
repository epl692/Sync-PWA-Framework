// T074: a user has at most 10 active devices; a revoked device frees a slot; adding your own device needs no particular role.
import { describe, expect, it } from 'vitest';
import { SYS } from '../../src/authority/types';
import { basicSpace, device, ev } from '../helpers';

describe('devices per user', () => {
  it('allows ten active devices (even for a Viewer) and refuses the eleventh', () => {
    const { auth } = basicSpace();
    for (let i = 0; i < 9; i++) auth.add(device('C', 10 + i, 'C', `C-${i}`)); // C is a Viewer, with one device already
    expect(auth.activeDevices('C')).toHaveLength(10);
    auth.add(device('C', 30, 'C', 'C-too-many'));
    expect(auth.activeDevices('C')).toHaveLength(10);
    expect(auth.state.inert.at(-1)).toMatchObject({ type: SYS.device, reason: 'too-many-devices' });
  });

  it('a revoked device frees its slot', () => {
    const { auth } = basicSpace();
    for (let i = 0; i < 9; i++) auth.add(device('C', 10 + i, 'C', `C-${i}`));
    auth.add(ev(SYS.deviceRevoke, 'C', 30, { device: 'C-0', cutoff: 0 }));
    auth.add(device('C', 31, 'C', 'C-new'));
    expect(auth.activeDevices('C').map((d) => d.id)).toContain('C-new');
    expect(auth.activeDevices('C')).toHaveLength(10);
  });
});
