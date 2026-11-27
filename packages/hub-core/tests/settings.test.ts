// Spec 005 data-model "Hub": defaults and validation of Hub settings.
import { describe, expect, it } from 'vitest';
import { SettingsError, defaultSettings, mergeSettings, validateSettings } from '../src/settings';

describe('defaultSettings', () => {
  it('uses the documented defaults', () => {
    const s = defaultSettings({ fingerprintText: 'abcd-efgh-ijkl', platformMaxClients: 20 });
    expect(s.displayName).toBe('Hub-ABCD');
    expect(s.accessMode).toBe('open');
    expect(s.autoSpaces).toBe(false);
    expect(s.maxClients).toBe(7); // min(7, platform limit)
    expect(s.retentionDays).toBe(14);
    expect(s.storageLimitBytes).toBe(1024 ** 3);
    expect(s.perSpaceCapBytes).toBe(Math.floor(1024 ** 3 * 0.25));
  });

  it('maxClients follows a lower platform limit and is at least 1', () => {
    expect(defaultSettings({ fingerprintText: 'x', platformMaxClients: 4 }).maxClients).toBe(4);
    expect(defaultSettings({ fingerprintText: 'x', platformMaxClients: 0 }).maxClients).toBe(1);
    expect(defaultSettings({ fingerprintText: 'x' }).maxClients).toBe(7);
  });
});

describe('validateSettings', () => {
  const ok = defaultSettings({ fingerprintText: 'abcd' });
  const bad = (patch: Record<string, unknown>, field: string) => {
    try {
      validateSettings({ ...ok, ...patch } as never);
      throw new Error('expected a SettingsError');
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsError);
      expect((e as SettingsError).field).toBe(field);
    }
  };

  it('accepts the defaults', () => {
    expect(() => validateSettings(ok)).not.toThrow();
  });
  it('displayName is 1 to 32 characters', () => {
    bad({ displayName: '' }, 'displayName');
    bad({ displayName: '   ' }, 'displayName');
    bad({ displayName: 'x'.repeat(33) }, 'displayName');
    expect(() => validateSettings({ ...ok, displayName: 'x'.repeat(32) })).not.toThrow();
  });
  it('accessMode is open or approval', () => bad({ accessMode: 'closed' }, 'accessMode'));
  it('retentionDays is an integer from 1 to 365', () => {
    bad({ retentionDays: 0 }, 'retentionDays');
    bad({ retentionDays: 366 }, 'retentionDays');
    bad({ retentionDays: 1.5 }, 'retentionDays');
    expect(() => validateSettings({ ...ok, retentionDays: 365 })).not.toThrow();
    expect(() => validateSettings({ ...ok, retentionDays: 1 })).not.toThrow();
  });
  it('maxClients is an integer of at least 1', () => {
    bad({ maxClients: 0 }, 'maxClients');
    bad({ maxClients: 2.5 }, 'maxClients');
  });
  it('storage limits are positive and the per-Space cap does not exceed the total', () => {
    bad({ storageLimitBytes: 0 }, 'storageLimitBytes');
    bad({ perSpaceCapBytes: 0 }, 'perSpaceCapBytes');
    bad({ storageLimitBytes: 1000, perSpaceCapBytes: 2000 }, 'perSpaceCapBytes');
  });
  it('booleans must be booleans', () => {
    bad({ autoSpaces: 'yes' }, 'autoSpaces');
    bad({ hubToHub: 1 }, 'hubToHub');
    bad({ keepAwake: null }, 'keepAwake');
  });
});

describe('mergeSettings', () => {
  it('applies a patch and validates the result', () => {
    const cur = defaultSettings({ fingerprintText: 'abcd' });
    expect(mergeSettings(cur, { retentionDays: 30, accessMode: 'approval' })).toMatchObject({ retentionDays: 30, accessMode: 'approval' });
    expect(() => mergeSettings(cur, { retentionDays: 0 })).toThrow(SettingsError);
    expect(cur.retentionDays).toBe(14); // the input is not mutated
  });
  it('trims the display name', () => {
    const cur = defaultSettings({ fingerprintText: 'abcd' });
    expect(mergeSettings(cur, { displayName: '  Camp  ' }).displayName).toBe('Camp');
  });
});
