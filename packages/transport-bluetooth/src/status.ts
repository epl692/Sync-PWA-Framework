/** Transport status and the support check (contracts/transport-bluetooth.ts). Messages tell the user what to do (spec FR-029). */

import type { TransportState } from '@sync/core';

export type BluetoothTransportStatus =
  | { kind: 'unsupported'; reason: 'no-web-bluetooth' | 'insecure-context' | 'no-bluetooth-adapter'; message: string }
  | { kind: 'unavailable'; reason: 'bluetooth-off' | 'permission-denied' | 'blocked-by-policy'; message: string }
  | { kind: 'needs-hub'; message: string }
  | { kind: 'ready' }
  | { kind: 'full'; hub: string; retryAfterMs: number };

export interface Env {
  /** The browser Bluetooth object (or the simulator), if present. */
  bluetooth?: unknown;
  isSecureContext?: boolean;
  /** The browser's own answer to `getAvailability()`, when known. */
  adapterAvailable?: boolean;
}

/** Cheap, synchronous check (the 001 `supported()` contract). Never throws. */
export function checkSupport(env: Env): { ok: true } | { ok: false; reason: string; status: Extract<BluetoothTransportStatus, { kind: 'unsupported' }> } {
  const fail = (reason: Extract<BluetoothTransportStatus, { kind: 'unsupported' }>['reason'], message: string) => ({
    ok: false as const,
    reason: message,
    status: { kind: 'unsupported' as const, reason, message },
  });
  if (!env.bluetooth) {
    return fail('no-web-bluetooth', 'This browser cannot use Bluetooth. Use Chrome or Edge on Android, Windows, macOS, Linux or ChromeOS. Safari, Firefox and iPhone or iPad browsers do not support it.');
  }
  if (env.isSecureContext === false) return fail('insecure-context', 'Bluetooth only works on a secure (https) page.');
  if (env.adapterAvailable === false) return fail('no-bluetooth-adapter', 'This device has no Bluetooth adapter.');
  return { ok: true };
}

/** Map a status onto the 001 `TransportState`. */
export function toTransportState(s: BluetoothTransportStatus, anyConnected: boolean): TransportState {
  switch (s.kind) {
    case 'unsupported':
      return 'unsupported';
    case 'unavailable':
    case 'needs-hub':
      return 'idle';
    case 'ready':
      return 'ready';
    case 'full':
      return anyConnected ? 'ready' : 'error';
  }
}

export function describeStatus(s: BluetoothTransportStatus): string {
  switch (s.kind) {
    case 'unsupported':
    case 'unavailable':
    case 'needs-hub':
      return s.message;
    case 'ready':
      return 'Connected to a Hub.';
    case 'full':
      return `${s.hub} is full right now. Trying again in ${Math.ceil(s.retryAfterMs / 1000)} seconds.`;
  }
}
