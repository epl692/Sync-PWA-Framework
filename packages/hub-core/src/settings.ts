/** Hub settings: defaults and validation (specs/005-bluetooth-transport/data-model.md, "Hub"). */

import type { HubSettings } from './types';

export class SettingsError extends Error {
  constructor(
    readonly field: keyof HubSettings,
    message: string,
  ) {
    super(message);
  }
}

const GIB = 1024 ** 3;

/** `fingerprintText` seeds the default name `Hub-XXXX`; `platformMaxClients` is what the radio supports (spike S-3). */
export function defaultSettings(o: { fingerprintText: string; platformMaxClients?: number }): HubSettings {
  const letters = o.fingerprintText.replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'HUB0';
  return {
    displayName: `Hub-${letters}`,
    accessMode: 'open',
    autoSpaces: false,
    maxClients: Math.max(1, Math.min(7, Math.floor(o.platformMaxClients ?? 7))),
    retentionDays: 14,
    storageLimitBytes: GIB,
    perSpaceCapBytes: Math.floor(GIB * 0.25),
    hubToHub: true,
    keepAwake: false,
  };
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/** Throws `SettingsError` naming the field. */
export function validateSettings(s: HubSettings): void {
  const name = typeof s.displayName === 'string' ? s.displayName.trim() : '';
  if (name.length < 1 || name.length > 32) throw new SettingsError('displayName', 'displayName must be 1 to 32 characters');
  if (s.accessMode !== 'open' && s.accessMode !== 'approval') throw new SettingsError('accessMode', 'accessMode must be "open" or "approval"');
  if (typeof s.autoSpaces !== 'boolean') throw new SettingsError('autoSpaces', 'autoSpaces must be true or false');
  if (typeof s.hubToHub !== 'boolean') throw new SettingsError('hubToHub', 'hubToHub must be true or false');
  if (typeof s.keepAwake !== 'boolean') throw new SettingsError('keepAwake', 'keepAwake must be true or false');
  if (!isInt(s.maxClients) || s.maxClients < 1) throw new SettingsError('maxClients', 'maxClients must be an integer of at least 1');
  if (!isInt(s.retentionDays) || s.retentionDays < 1 || s.retentionDays > 365) throw new SettingsError('retentionDays', 'retentionDays must be an integer from 1 to 365');
  if (!isInt(s.storageLimitBytes) || s.storageLimitBytes < 1) throw new SettingsError('storageLimitBytes', 'storageLimitBytes must be a positive integer');
  if (!isInt(s.perSpaceCapBytes) || s.perSpaceCapBytes < 1 || s.perSpaceCapBytes > s.storageLimitBytes) {
    throw new SettingsError('perSpaceCapBytes', 'perSpaceCapBytes must be positive and at most storageLimitBytes');
  }
}

export function mergeSettings(cur: HubSettings, patch: Partial<HubSettings>): HubSettings {
  const next = { ...cur, ...patch };
  if (typeof next.displayName === 'string') next.displayName = next.displayName.trim();
  validateSettings(next);
  return next;
}
