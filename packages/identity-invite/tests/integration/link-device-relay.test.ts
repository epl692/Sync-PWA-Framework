// A brand-new device has no Spaces. A relay only forwards a device's messages once it has announced a Space, so the link code
// carries one for the new device to announce. Without it, linking works node-to-node (the other link tests) but never through a relay.
import { describe, expect, it } from 'vitest';
import { HubNetwork, createFakeClock, createSecureNode, scanForPlaintext, waitFor } from '@sync/testkit';
import { createInviteProvider } from '../../src';

const provider = () => createInviteProvider({ baseUrl: 'https://app.test/', joinTimeoutMs: 8000 });

describe('linking another device through a relay', () => {
  it('a new device with no Spaces reaches the existing device, is approved, and gets the data', async () => {
    const net = new HubNetwork();
    const clock = createFakeClock();
    const phone = await createSecureNode({ name: 'phone', clock, provider, approveLink: () => true });
    const tablet = await createSecureNode({ name: 'tablet', clock, provider, signUp: false });
    phone.core.addTransport(net.transport('phone'));
    tablet.core.addTransport(net.transport('tablet'));

    const home = await phone.spaces.create('Home');
    const note = await phone.core.create(home.id, 'note', { text: 'MRK-link-8c1' });

    const { code, done } = await phone.spaces.linkDevice();
    const session = await tablet.spaces.joinAsDevice(code, { timeoutMs: 8000 });
    expect(session.user).toBe(phone.spaces.session()!.user);
    expect((await done).device).toBe(tablet.core.deviceId);

    await waitFor(async () => (await tablet.core.get(note.id)) !== undefined, 10_000, 'the tablet reads the data');
    expect(scanForPlaintext(net.everything(), ['MRK-link-8c1'])).toEqual([]);
    expect(net.seen.some((m) => new TextDecoder().decode(m).includes('"t":"chan"'))).toBe(true); // the handshake went through the relay
  });
});
