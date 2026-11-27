// @vitest-environment jsdom
import { describe, expect, it, beforeAll } from 'vitest';
import { BluetoothPanel, defineBluetoothPanel, type PanelTransport } from '../../src/ui/bluetooth-panel';
import { errorMessage, type BluetoothTransportStatus } from '../../src/status';
import type { HubConnectionInfo } from '../../src/clientLink';

beforeAll(() => defineBluetoothPanel());

function fake(initial: BluetoothTransportStatus, conns: HubConnectionInfo[] = []) {
  let status = initial;
  let list = conns;
  const sh = new Set<(s: BluetoothTransportStatus) => void>();
  const ch = new Set<(c: HubConnectionInfo[]) => void>();
  const calls = { choose: 0, left: [] as string[] };
  let chooseImpl: () => Promise<unknown> = async () => undefined;
  const t: PanelTransport = {
    status: () => status,
    connections: () => list,
    chooseHub: () => (calls.choose++, chooseImpl()),
    disconnectHub: async (fp) => void calls.left.push(fp),
    onStatus: (h) => (sh.add(h), () => void sh.delete(h)),
    onConnections: (h) => (ch.add(h), () => void ch.delete(h)),
  };
  return { t, calls, setStatus: (s: BluetoothTransportStatus) => ((status = s), sh.forEach((h) => h(s))), setConns: (c: HubConnectionInfo[]) => ((list = c), ch.forEach((h) => h(c))), onChoose: (f: () => Promise<unknown>) => (chooseImpl = f) };
}
const conn = (over: Partial<HubConnectionInfo> = {}): HubConnectionInfo => ({ fingerprint: 'fp1', name: 'Camp hub', state: 'syncing', acceptedSpaces: ['S'], frameBytes: 182, pendingOut: 0, pendingIn: 0, ...over });
const mount = (t: PanelTransport) => {
  const el = document.createElement('sync-bluetooth-panel') as BluetoothPanel;
  document.body.appendChild(el);
  el.transport = t;
  return el;
};

describe('<sync-bluetooth-panel>', () => {
  it('with no Hub, explains how to get one and offers "Find a Hub"', () => {
    const f = fake({ kind: 'needs-hub', message: 'Find a Hub to sync with.' });
    const el = mount(f.t);
    expect(el.querySelector('.bt-status')!.textContent).toBe('Find a Hub to sync with.');
    expect(el.textContent).toMatch(/running a Hub/);
    const btn = el.querySelector('[data-act="find"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Find a Hub');
  });

  it('on an unsupported browser, says which browsers work, disables the button, and keeps the app usable', () => {
    const f = fake({ kind: 'unsupported', reason: 'no-web-bluetooth', message: 'This browser cannot use Bluetooth. Use Chrome or Edge.' });
    const el = mount(f.t);
    expect((el.querySelector('[data-act="find"]') as HTMLButtonElement).disabled).toBe(true);
    expect(el.textContent).toMatch(/Chrome or Edge/);
    expect(el.textContent).toMatch(/other connections/);
  });

  it('pressing the button asks the transport to choose a Hub; a failure is shown as a plain message in an alert', async () => {
    const f = fake({ kind: 'needs-hub', message: 'Find a Hub' });
    f.onChoose(async () => {
      throw Object.assign(new Error('x'), { code: 'cancelled' });
    });
    const el = mount(f.t);
    await el.find();
    expect(f.calls.choose).toBe(1);
    const alert = el.querySelector('[role="alert"]')!;
    expect(alert.textContent).toMatch(/Make sure a Hub is running/);
    expect((el.querySelector('[data-act="find"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows each Hub with a readable state, offers disconnect, and updates live', async () => {
    const f = fake({ kind: 'ready' }, [conn()]);
    const el = mount(f.t);
    expect(el.querySelector('.state')!.textContent).toBe('Syncing');
    (el.querySelector('[data-act="leave"]') as HTMLButtonElement).click();
    expect(f.calls.left).toEqual(['fp1']);
    f.setConns([conn({ state: 'pending', detail: 'Waiting for the Hub owner to approve this device.' })]);
    expect(el.querySelector('.state')!.textContent).toMatch(/Waiting for the Hub owner/);
    f.setConns([]);
    expect(el.querySelector('.bt-hubs')).toBeNull();
  });

  it('is operable by keyboard and labelled for screen readers', () => {
    const f = fake({ kind: 'ready' }, [conn()]);
    const el = mount(f.t);
    expect(el.querySelector('section')!.getAttribute('aria-labelledby')).toBe('bt-h');
    expect(el.querySelector('.bt-status')!.getAttribute('aria-live')).toBe('polite');
    for (const b of el.querySelectorAll('button')) expect(b.tagName).toBe('BUTTON'); // real buttons: focusable and keyboard operable
    expect(el.querySelector('[data-act="leave"]')!.getAttribute('aria-label')).toBe('Disconnect from Camp hub');
  });

  it('escapes Hub names (they come from the radio and are untrusted)', () => {
    const f = fake({ kind: 'ready' }, [conn({ name: '<img src=x onerror=alert(1)>' })]);
    const el = mount(f.t);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.name')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('errorMessage', () => {
  it('has a sentence for every known code and a fallback', () => {
    for (const c of ['cancelled', 'denied', 'no-service', 'connect-failed', 'update-needed', 'busy', 'identity-changed', 'declined', 'not-served', 'rejected', 'timeout']) {
      expect(errorMessage({ code: c }).length).toBeGreaterThan(10);
    }
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(undefined)).toMatch(/Something went wrong/);
  });
});
