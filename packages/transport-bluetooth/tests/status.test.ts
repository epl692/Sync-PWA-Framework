import { describe, expect, it } from 'vitest';
import { checkSupport, describeStatus, toTransportState, type BluetoothTransportStatus } from '../src/status';

describe('checkSupport', () => {
  it('ok with Web Bluetooth in a secure context', () => {
    expect(checkSupport({ bluetooth: {}, isSecureContext: true })).toEqual({ ok: true });
  });
  it('no Web Bluetooth names the browsers that work and never throws', () => {
    const r = checkSupport({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status.reason).toBe('no-web-bluetooth');
      expect(r.reason).toMatch(/Chrome or Edge/);
      expect(r.reason).toMatch(/Safari/);
    }
  });
  it('an insecure page and a missing adapter have their own reasons', () => {
    const a = checkSupport({ bluetooth: {}, isSecureContext: false });
    const b = checkSupport({ bluetooth: {}, isSecureContext: true, adapterAvailable: false });
    expect(!a.ok && a.status.reason).toBe('insecure-context');
    expect(!b.ok && b.status.reason).toBe('no-bluetooth-adapter');
  });
});

describe('status mapping', () => {
  const cases: Array<[BluetoothTransportStatus, boolean, string]> = [
    [{ kind: 'unsupported', reason: 'no-web-bluetooth', message: 'm' }, false, 'unsupported'],
    [{ kind: 'unavailable', reason: 'bluetooth-off', message: 'm' }, false, 'idle'],
    [{ kind: 'needs-hub', message: 'm' }, false, 'idle'],
    [{ kind: 'ready' }, true, 'ready'],
    [{ kind: 'full', hub: 'H', retryAfterMs: 3000 }, true, 'ready'],
    [{ kind: 'full', hub: 'H', retryAfterMs: 3000 }, false, 'error'],
  ];
  it.each(cases)('%j (connected=%s) -> %s', (s, connected, want) => expect(toTransportState(s, connected)).toBe(want));

  it('describeStatus gives a user-facing sentence for every kind', () => {
    expect(describeStatus({ kind: 'full', hub: 'Camp', retryAfterMs: 2500 })).toBe('Camp is full right now. Trying again in 3 seconds.');
    expect(describeStatus({ kind: 'ready' })).toBe('Connected to a Hub.');
    expect(describeStatus({ kind: 'needs-hub', message: 'Find a Hub' })).toBe('Find a Hub');
  });
});
