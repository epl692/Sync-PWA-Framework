// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type { ClientInfo, HubControl, HubEvent, HubSettings, ServedSpaceInfo } from '@sync/hub-core';
import { HubAccess, HubClients, HubSpaces, HubStatus, HubStorage, defineHubUi } from '../src';

beforeAll(() => defineHubUi());

function fakeHub(over: Partial<{ spaces: ServedSpaceInfo[]; clients: ClientInfo[] }> = {}) {
  const handlers = new Set<(e: HubEvent) => void>();
  const calls = { added: [] as string[], removed: [] as Array<[string, boolean]>, left: [] as string[], acts: [] as Array<[string, string]>, settings: [] as Array<Partial<HubSettings>> };
  const state = { spaces: over.spaces ?? [], clients: over.clients ?? [] };
  const settings: HubSettings = { displayName: 'Camp <hub>', accessMode: 'open', autoSpaces: false, maxClients: 7, retentionDays: 14, storageLimitBytes: 1 << 30, perSpaceCapBytes: 1 << 28, hubToHub: true, keepAwake: false };
  const hub = {
    fingerprint: '72as-yext-vngo-nlc5-w2nm-guxz-a3fr-wepp',
    settings: () => settings,
    spaces: () => state.spaces,
    clients: () => state.clients,
    addServeCode: async (c: string) => {
      if (c === 'bad') throw new Error('not a serve code');
      calls.added.push(c);
      return { space: 'S', source: 'code', epochs: [1], link: false, bytesStored: 0, addedAt: 0 } as ServedSpaceInfo;
    },
    removeSpace: async (s: string, o: { deleteStored: boolean }) => void calls.removed.push([s, o.deleteStored]),
    disconnect: async (d: string) => void calls.left.push(d),
    approve: async (d: string) => void calls.acts.push(['approve', d]),
    deny: async (d: string) => void calls.acts.push(['deny', d]),
    block: async (d: string) => void calls.acts.push(['block', d]),
    unblock: async (d: string) => void calls.acts.push(['unblock', d]),
    updateSettings: async (p: Partial<HubSettings>) => {
      if (p.retentionDays === 0) throw new Error('retentionDays must be an integer from 1 to 365');
      calls.settings.push(p);
    },
    storage: async () => ({ usedBytes: 5 * 1024 ** 2, limitBytes: 1024 ** 3, perSpace: { S1: 3 * 1024 ** 2 }, oldestPacketAt: Date.UTC(2026, 10, 20) }),
    on: (h: (e: HubEvent) => void) => (handlers.add(h), () => void handlers.delete(h)),
  } as unknown as HubControl;
  return { hub, calls, state, emit: (e: HubEvent) => handlers.forEach((h) => h(e)) };
}

const mount = <T extends HTMLElement>(tag: string, hub: HubControl): T => {
  const el = document.createElement(tag) as T & { control: HubControl };
  document.body.appendChild(el);
  el.control = hub;
  return el;
};

describe('<hub-status>', () => {
  it('shows the name (escaped), fingerprint, words and mode, and reacts to Bluetooth being turned off', () => {
    const f = fakeHub();
    const el = mount<HubStatus>('hub-status', f.hub);
    expect(el.querySelector('h2')!.textContent).toBe('Camp <hub>');
    expect(el.querySelector('code')!.textContent).toBe('72as-yext-vngo-nlc5-w2nm-guxz-a3fr-wepp');
    expect(el.querySelector('.hub-words')!.textContent).toMatch(/vortex mosaic clover blanket/);
    expect(el.querySelector('.hub-mode')!.textContent).toMatch(/open to members/);
    f.emit({ type: 'bridge-state', state: 'bluetooth-off' });
    expect(el.querySelector('.hub-bridge')!.textContent).toMatch(/turned off/);
    f.emit({ type: 'bridge-state', state: 'unsupported' });
    expect(el.querySelector('.hub-bridge')!.textContent).toMatch(/cannot act as a Hub/);
  });
});

describe('<hub-spaces>', () => {
  it('explains how to add a Space when empty, and adds a pasted code', async () => {
    const f = fakeHub();
    const el = mount<HubSpaces>('hub-spaces', f.hub);
    expect(el.textContent).toMatch(/export a "serve this Space" code/);
    (el.querySelector('input[name="code"]') as HTMLInputElement).value = '  syncserve:1:abc  ';
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls.added).toEqual(['syncserve:1:abc']);
  });

  it('shows the error when a code is rejected', async () => {
    const f = fakeHub();
    const el = mount<HubSpaces>('hub-spaces', f.hub);
    await el.add('bad');
    expect(el.querySelector('[role="alert"]')!.textContent).toBe('not a serve code');
  });

  it('lists Spaces and removes with or without deleting stored data (asking before deleting)', async () => {
    const f = fakeHub({ spaces: [{ space: 'S1', name: 'Family', source: 'auto', epochs: [1], link: true, bytesStored: 42, addedAt: 0 }] });
    const el = mount<HubSpaces>('hub-spaces', f.hub);
    expect(el.textContent).toMatch(/Family/);
    expect(el.textContent).toMatch(/added automatically/);
    expect(el.textContent).toMatch(/link to other Hubs/);
    (el.querySelector('[data-act="remove-keep"]') as HTMLElement).click();
    globalThis.confirm = () => false;
    (el.querySelector('[data-act="remove-delete"]') as HTMLElement).click();
    globalThis.confirm = () => true;
    (el.querySelector('[data-act="remove-delete"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls.removed).toEqual([['S1', false], ['S1', true]]);
  });
});

describe('<hub-clients>', () => {
  it('lists connected devices (escaped) and disconnects one', () => {
    const f = fakeHub({ clients: [{ device: 'D1', name: '<b>Maya</b>', state: 'trusted', connected: true, spaces: ['S'], lastSeen: 0 }] });
    const el = mount<HubClients>('hub-clients', f.hub);
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('.cl-name')!.textContent).toBe('<b>Maya</b>');
    (el.querySelector('[data-act="disconnect"]') as HTMLElement).click();
    expect(f.calls.left).toEqual(['D1']);
  });
  it('says when nobody is connected and updates on events', () => {
    const f = fakeHub();
    const el = mount<HubClients>('hub-clients', f.hub);
    expect(el.textContent).toMatch(/No devices/);
    f.state.clients = [{ device: 'D', name: 'x', state: 'trusted', connected: true, spaces: [], lastSeen: 0 }];
    f.emit({ type: 'client-connected', client: f.state.clients[0]! });
    expect(el.querySelector('li')).not.toBeNull();
  });
});

describe('<hub-clients> owner actions', () => {
  const mk = (state: ClientInfo['state'], connected = true): ClientInfo => ({ device: 'D', name: 'Maya', state, connected, spaces: [], lastSeen: 0 });
  const click = (el: HTMLElement, act: string) => (el.querySelector(`[data-act="${act}"]`) as HTMLElement).click();

  it('a pending device can be approved or denied, and the owner is told how many are waiting', async () => {
    const f = fakeHub({ clients: [mk('pending')] });
    const el = mount<HubClients>('hub-clients', f.hub);
    expect(el.querySelector('.cl-pending')!.textContent).toBe('1 device is waiting for your approval.');
    click(el, 'approve');
    click(el, 'deny');
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls.acts).toEqual([['approve', 'D'], ['deny', 'D']]);
  });
  it('a trusted device can be blocked, a blocked one unblocked; disconnect only when connected', async () => {
    const f = fakeHub({ clients: [mk('trusted', false)] });
    const el = mount<HubClients>('hub-clients', f.hub);
    expect(el.querySelector('[data-act="disconnect"]')).toBeNull();
    click(el, 'block');
    const f2 = fakeHub({ clients: [mk('blocked', false)] });
    const el2 = mount<HubClients>('hub-clients', f2.hub);
    click(el2, 'unblock');
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls.acts).toEqual([['block', 'D']]);
    expect(f2.calls.acts).toEqual([['unblock', 'D']]);
  });
});

describe('<hub-access>', () => {
  it('switches between open and approval mode and toggles automatic Spaces', () => {
    const f = fakeHub();
    const el = mount<HubAccess>('hub-access', f.hub);
    expect((el.querySelector('input[value="open"]') as HTMLInputElement).checked).toBe(true);
    const approval = el.querySelector('input[value="approval"]') as HTMLInputElement;
    approval.checked = true;
    approval.dispatchEvent(new Event('change'));
    const auto = el.querySelector('input[name="auto"]') as HTMLInputElement;
    auto.checked = true;
    auto.dispatchEvent(new Event('change'));
    expect(f.calls.settings).toEqual([{ accessMode: 'approval' }, { autoSpaces: true }]);
    expect(el.textContent).toMatch(/can fill the Hub's storage/);
  });
});

describe('<hub-storage>', () => {
  it('shows usage per Space, the oldest change, and the retention and limit controls', async () => {
    const f = fakeHub({ spaces: [{ space: 'S1', name: 'Family', source: 'code', epochs: [1], link: false, bytesStored: 0, addedAt: 0 }] });
    const el = mount<HubStorage>('hub-storage', f.hub);
    await el.refresh();
    expect(el.querySelector('.st-used')!.textContent).toBe('5.0 MB of 1.0 GB used. Oldest change: 2026-11-20');
    expect(el.querySelector('.st-spaces')!.textContent).toBe('Family: 3.0 MB');
    expect((el.querySelector('input[name="days"]') as HTMLInputElement).value).toBe('14');
    expect((el.querySelector('input[name="limit"]') as HTMLInputElement).value).toBe('1024');
  });
  it('saves a new retention period, shows an error for a value the Hub refuses, and warns when storage runs short', async () => {
    const f = fakeHub();
    const el = mount<HubStorage>('hub-storage', f.hub);
    await el.refresh();
    await el.save({ retentionDays: 30 });
    await el.save({ retentionDays: 0 });
    expect(f.calls.settings).toEqual([{ retentionDays: 30 }]);
    expect(el.querySelector('.st-error')!.textContent).toMatch(/1 to 365/);
    f.emit({ type: 'storage-warning', level: 'evicting-undelivered', bytes: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('.st-warning')!.textContent).toMatch(/deleting changes that no other device has received/);
  });
});
