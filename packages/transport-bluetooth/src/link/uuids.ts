/** GATT identifiers and the version range of link/1 (specs/005-bluetooth-transport/contracts/bluetooth-link.md). */

export const LINK_UUIDS = {
  serviceUuid: 'a89242f7-786e-4bf2-9b00-b028957dc0eb',
  infoUuid: 'c71b9f0e-0fc5-48bd-9bff-6428700a9eea',
  txUuid: '9ec66df3-0a3e-4c6a-a381-37405b5ac00c',
  rxUuid: '16d9aa8a-90ef-407b-a339-80534210840d',
} as const;

/** The link protocol versions this build speaks. */
export const LINK_VERSIONS: [number, number] = [1, 1];

/** Contents of the INFO characteristic (readable before any handshake). */
export interface HubInfo {
  v: [number, number];
  name: string;
  /** Fingerprint text (8 groups of 4). Untrusted until the handshake pins the key. */
  fp: string;
  mode: 'open' | 'approval';
  slots: number;
  full: boolean;
  /** Automatic Space mode is on: a client may send a `claim`. */
  auto?: boolean;
  maxWrite: number;
}

export function encodeInfo(i: HubInfo): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(i));
}

/** Null for anything that is not a plausible INFO value. */
export function parseInfo(b: Uint8Array): HubInfo | null {
  if (b.length > 512) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(b)) as Partial<HubInfo>;
    if (!o || typeof o !== 'object') return null;
    if (!Array.isArray(o.v) || o.v.length !== 2 || !o.v.every((n) => Number.isInteger(n))) return null;
    if (typeof o.name !== 'string' || typeof o.fp !== 'string') return null;
    if (o.mode !== 'open' && o.mode !== 'approval') return null;
    const slots = typeof o.slots === 'number' && o.slots >= 0 ? Math.floor(o.slots) : 0;
    return {
      v: [o.v[0]!, o.v[1]!],
      name: o.name.slice(0, 64),
      fp: o.fp.slice(0, 64),
      mode: o.mode,
      slots,
      full: o.full === true || slots === 0,
      ...(o.auto === true ? { auto: true } : {}),
      maxWrite: typeof o.maxWrite === 'number' ? Math.min(Math.max(20, Math.floor(o.maxWrite)), 512) : 20,
    };
  } catch {
    return null;
  }
}
