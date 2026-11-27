/**
 * Sidecar bridge client (specs/005-bluetooth-transport/contracts/hub-ble-bridge.md, "JSON-lines sidecar protocol"): the desktop Hub talks
 * to a small per-OS program (Windows WinRT, macOS CoreBluetooth) over stdin and stdout, one JSON object per line, binary as base64.
 * This file is the TypeScript side; it knows nothing about how the process is started (that is the shell's job).
 */

import { BleError, type AdvertisingOptions, type BleBridge, type BleBridgeEvents, type BleConnId, type BleSupport } from '../bridge';

/** The two ends of the sidecar's stdio, as the shell provides them. */
export interface SidecarProcess {
  /** Send one line (no trailing newline needed). */
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  /** The process ended (crash, kill, or stdin closed). */
  onExit(cb: () => void): void;
  kill(): void;
}

export const SUPPORTED_SIDECAR_VERSIONS = [1];
export const MAX_LINE_BYTES = 8 * 1024;

const b64 = (b: Uint8Array) => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: unknown): Uint8Array => {
  if (typeof s !== 'string') return new Uint8Array(0);
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array(0);
  }
};

type Handlers = { [K in keyof BleBridgeEvents]: Set<BleBridgeEvents[K]> };

export class SidecarError extends BleError {}

/**
 * Wait for the sidecar's hello (refusing a version we do not know), then return a `BleBridge` that forwards every call as a request.
 */
export async function createSidecarBridge(proc: SidecarProcess, o: { requestTimeoutMs?: number; helloTimeoutMs?: number } = {}): Promise<BleBridge & { bridgeName: string; version: number }> {
  const timeout = o.requestTimeoutMs ?? 10_000;
  const h: Handlers = { connected: new Set(), mtu: new Set(), write: new Set(), disconnected: new Set(), state: new Set(), seen: new Set(), notify: new Set() };
  const pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const conns = new Set<BleConnId>();
  let nextId = 1;
  let dead = false;
  let helloDone!: (hello: { bridge: string; version: number }) => void;
  let helloFailed!: (e: Error) => void;
  const hello = new Promise<{ bridge: string; version: number }>((res, rej) => ((helloDone = res), (helloFailed = rej)));

  const emit = <K extends keyof BleBridgeEvents>(e: K, ...a: Parameters<BleBridgeEvents[K]>) => {
    for (const f of [...h[e]]) (f as (...x: unknown[]) => void)(...a);
  };

  const fail = (why: string) => {
    if (dead) return;
    dead = true;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new SidecarError('bridge-failed', why));
    }
    pending.clear();
    helloFailed(new SidecarError('bridge-failed', why));
    for (const c of [...conns]) emit('disconnected', c, why);
    conns.clear();
    emit('state', 'advertising-failed');
  };

  proc.onExit(() => fail('the Bluetooth helper program stopped'));
  proc.onLine((line) => {
    if (dead) return;
    if (new TextEncoder().encode(line).length > MAX_LINE_BYTES) return fail('the Bluetooth helper sent an oversized line');
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return fail('the Bluetooth helper sent something that is not JSON');
    }
    if (!m || typeof m !== 'object') return fail('the Bluetooth helper sent an unexpected message');
    if (typeof m.id === 'number') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.ok === true) p.resolve(m);
      else {
        const known = ['frame-too-large', 'not-connected', 'unsupported', 'bridge-failed'] as const;
        const code = known.find((k) => k === m.code) ?? 'bridge-failed';
        p.reject(new SidecarError(code, typeof m.message === 'string' ? m.message : 'the Bluetooth helper reported an error'));
      }
      return;
    }
    switch (m.event) {
      case 'hello':
        if (typeof m.version === 'number' && SUPPORTED_SIDECAR_VERSIONS.includes(m.version)) helloDone({ bridge: String(m.bridge ?? 'unknown'), version: m.version });
        else {
          helloFailed(new SidecarError('bridge-failed', `the Bluetooth helper speaks version ${String(m.version)}, which this app does not support`));
          proc.kill();
          dead = true;
        }
        break;
      case 'connected':
        conns.add(String(m.conn));
        emit('connected', String(m.conn), { mtu: Number(m.mtu) || 23 });
        break;
      case 'mtu':
        emit('mtu', String(m.conn), Number(m.mtu) || 23);
        break;
      case 'write':
        emit('write', String(m.conn), unb64(m.frame));
        break;
      case 'notify':
        emit('notify', String(m.conn), unb64(m.frame));
        break;
      case 'disconnected':
        if (conns.delete(String(m.conn))) emit('disconnected', String(m.conn), typeof m.reason === 'string' ? m.reason : undefined);
        break;
      case 'state':
        if (m.state === 'ready' || m.state === 'bluetooth-off' || m.state === 'permission-denied' || m.state === 'advertising-failed') emit('state', m.state);
        break;
      case 'seen':
        emit('seen', { address: String(m.address), ...(typeof m.name === 'string' ? { name: m.name } : {}), ...(typeof m.rssi === 'number' ? { rssi: m.rssi } : {}) });
        break;
      default:
        break; // unknown events from a newer sidecar are ignored
    }
  });

  const helloTimer = setTimeout(() => helloFailed(new SidecarError('bridge-failed', 'the Bluetooth helper did not start')), o.helloTimeoutMs ?? 10_000);
  let info: { bridge: string; version: number };
  try {
    info = await hello;
  } finally {
    clearTimeout(helloTimer);
  }

  const request = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (dead) return Promise.reject(new SidecarError('bridge-failed', 'the Bluetooth helper is not running'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new SidecarError('bridge-failed', `the Bluetooth helper did not answer ${op}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      proc.write(JSON.stringify({ id, op, ...args }));
    });
  };

  const bridge: BleBridge & { bridgeName: string; version: number } = {
    bridgeName: info.bridge,
    version: info.version,
    async support() {
      try {
        const r = await request('support');
        return { peripheral: r.peripheral, central: r.central } as BleSupport;
      } catch (e) {
        const fail1 = { ok: false as const, reason: (e as Error).message, code: 'bridge-failed' as const };
        return { peripheral: fail1, central: fail1 };
      }
    },
    async startAdvertising(opts: AdvertisingOptions) {
      await request('startAdvertising', { ...opts, info: b64(opts.info) });
    },
    async setInfo(i) {
      await request('setInfo', { info: b64(i) });
    },
    async stopAdvertising() {
      await request('stopAdvertising');
    },
    async notify(conn, frame) {
      await request('notify', { conn, frame: b64(frame) });
    },
    async disconnect(conn) {
      await request('disconnect', { conn });
    },
    async startScan(serviceUuid) {
      await request('startScan', { serviceUuid });
    },
    async stopScan() {
      await request('stopScan');
    },
    async connect(address) {
      const r = await request('connect', { address });
      conns.add(String(r.conn));
      return { conn: String(r.conn), mtu: Number(r.mtu) || 23, info: unb64(r.info) };
    },
    async write(conn, frame) {
      await request('write', { conn, frame: b64(frame) });
    },
    on(event, handler) {
      h[event].add(handler);
      return () => void h[event].delete(handler);
    },
    async close() {
      if (dead) return;
      try {
        await request('close');
      } catch {
        /* going away anyway */
      }
      dead = true;
      proc.kill();
    },
  };
  return bridge;
}
