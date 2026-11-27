/**
 * Client records and access decisions (data-model "ClientRecord"; spec FR-012, FR-015, FR-026). States: unknown -> pending ->
 * trusted | blocked. In open mode a member that proves a served Space is trusted at once; in approval mode a new device waits for
 * the owner. Strikes are counted per authenticated device (never against a claimed ID before it is proven).
 */

import type { HubStore } from './store/types';
import type { ClientRecord, DeviceId, HubSettings } from './types';

export const STRIKE_WINDOW_MS = 10 * 60_000;
export const STRIKE_LIMIT = 3;
export const BLOCK_MS = 15 * 60_000;

export type Verdict = 'trusted' | 'pending' | 'blocked';

/** What the link server asks of the registry. */
export interface ClientGate {
  decide(a: { device: DeviceId; name: string; spaces: string[] }): Promise<Verdict>;
  /** Resolves when the owner approves or denies a pending device, or immediately if it was already decided. */
  decision(device: DeviceId): Promise<'approved' | 'denied'>;
  /** Record a strike against an authenticated device. True if that blocked it. */
  strike(device: DeviceId): boolean;
  /** A device connected or disconnected (keeps `lastSeen`). */
  seen(device: DeviceId, spaces: string[]): void;
}

export class ClientRegistry implements ClientGate {
  private readonly records = new Map<DeviceId, ClientRecord>();
  private readonly strikeTimes = new Map<DeviceId, number[]>();
  private readonly waiters = new Map<DeviceId, Array<(d: 'approved' | 'denied') => void>>();
  private readonly listeners = new Set<(e: { type: 'pending' | 'blocked' | 'changed'; record: ClientRecord }) => void>();

  constructor(
    private readonly store: HubStore,
    private readonly settings: () => HubSettings,
    private readonly now: () => number,
  ) {}

  async load(): Promise<void> {
    for (const r of await this.store.clients()) this.records.set(r.device, r);
  }

  on(h: (e: { type: 'pending' | 'blocked' | 'changed'; record: ClientRecord }) => void): () => void {
    this.listeners.add(h);
    return () => void this.listeners.delete(h);
  }
  private emit(type: 'pending' | 'blocked' | 'changed', record: ClientRecord): void {
    for (const h of [...this.listeners]) h({ type, record: structuredClone(record) });
  }
  private save(r: ClientRecord): void {
    void this.store.putClient(structuredClone(r)).catch(() => undefined);
  }

  all(): ClientRecord[] {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
  get(device: DeviceId): ClientRecord | undefined {
    const r = this.records.get(device);
    return r && structuredClone(r);
  }

  isBlocked(device: DeviceId): boolean {
    const r = this.records.get(device);
    if (!r) return false;
    return r.state === 'blocked' || (r.blockedUntil !== undefined && r.blockedUntil > this.now());
  }

  async decide(a: { device: DeviceId; name: string; spaces: string[] }): Promise<Verdict> {
    const t = this.now();
    let r = this.records.get(a.device);
    if (r && (r.state === 'blocked' || (r.blockedUntil !== undefined && r.blockedUntil > t))) return 'blocked';
    if (r?.blockedUntil !== undefined && r.blockedUntil <= t) {
      delete r.blockedUntil; // a temporary block has run out
      r.strikes = 0;
    }
    const open = this.settings().accessMode === 'open';
    if (!r) {
      r = { device: a.device, name: a.name, state: open ? 'trusted' : 'pending', strikes: 0, lastSeen: t, spaces: [...a.spaces] };
      this.records.set(a.device, r);
    } else {
      r.name = a.name;
      r.lastSeen = t;
      r.spaces = [...a.spaces];
      if (r.state === 'pending' && open) r.state = 'trusted'; // the owner switched to open mode while it waited
      if (r.state !== 'trusted' && !open) r.state = 'pending';
    }
    this.save(r);
    if (r.state === 'pending') this.emit('pending', r);
    else this.emit('changed', r);
    return r.state === 'trusted' ? 'trusted' : 'pending';
  }

  decision(device: DeviceId): Promise<'approved' | 'denied'> {
    const r = this.records.get(device);
    if (r?.state === 'trusted') return Promise.resolve('approved');
    if (r?.state === 'blocked') return Promise.resolve('denied');
    return new Promise((resolve) => {
      const list = this.waiters.get(device) ?? [];
      list.push(resolve);
      this.waiters.set(device, list);
    });
  }

  private settle(device: DeviceId, d: 'approved' | 'denied'): void {
    for (const w of this.waiters.get(device)?.splice(0) ?? []) w(d);
  }

  approve(device: DeviceId): boolean {
    const r = this.records.get(device);
    if (!r) return false;
    r.state = 'trusted';
    delete r.blockedUntil;
    r.strikes = 0;
    this.save(r);
    this.emit('changed', r);
    this.settle(device, 'approved');
    return true;
  }

  /** Deny a pending device: it is blocked until the owner unblocks it. */
  deny(device: DeviceId): boolean {
    return this.block(device);
  }

  block(device: DeviceId): boolean {
    const r = this.records.get(device);
    if (!r) return false;
    r.state = 'blocked';
    delete r.blockedUntil;
    this.save(r);
    this.emit('blocked', r);
    this.settle(device, 'denied');
    return true;
  }

  /** The owner lifts a block: the record is forgotten, so the device is unknown again. */
  unblock(device: DeviceId): boolean {
    const r = this.records.get(device);
    if (!r || (r.state !== 'blocked' && r.blockedUntil === undefined)) return false;
    this.records.delete(device);
    this.strikeTimes.delete(device);
    void this.store.deleteClient(device).catch(() => undefined);
    this.emit('changed', { ...r, state: 'pending' });
    return true;
  }

  strike(device: DeviceId): boolean {
    const r = this.records.get(device);
    if (!r) return false;
    const t = this.now();
    const times = (this.strikeTimes.get(device) ?? []).filter((x) => t - x < STRIKE_WINDOW_MS);
    times.push(t);
    this.strikeTimes.set(device, times);
    r.strikes = times.length;
    if (times.length >= STRIKE_LIMIT) {
      r.blockedUntil = t + BLOCK_MS;
      r.strikes = 0;
      this.strikeTimes.delete(device);
      this.save(r);
      this.emit('blocked', r);
      return true;
    }
    this.save(r);
    return false;
  }

  seen(device: DeviceId, spaces: string[]): void {
    const r = this.records.get(device);
    if (!r) return;
    r.lastSeen = this.now();
    if (spaces.length) r.spaces = [...spaces];
    this.save(r);
  }
}
