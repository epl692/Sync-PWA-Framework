/**
 * Keeps one Authority per Space in step with the core's log. It loads a Space's control events from the
 * applied packets on first use, then follows `core.onApplied` (A-8) synchronously, so the next packet in
 * the same batch already sees the new state.
 */

import type { PacketBody, SyncCore, DataPacketEnvelope } from '@sync/core';
import { Authority, type AuthorityOptions } from './authority';
import { SYS, SYS_PREFIX, isSysType, type ControlEvent } from './types';
import type { InertRec } from './types';

export interface ControlApplied {
  space: string;
  event: ControlEvent;
  retroactive: boolean;
  newInert: InertRec[];
  /** Packet came from this device. */
  local: boolean;
}

export interface AuthorityView {
  ensure(space: string): Promise<Authority>;
}

export function toControlEvent(env: DataPacketEnvelope, body: PacketBody): ControlEvent | undefined {
  if (!body.type.startsWith(SYS_PREFIX) || !isSysType(body.type) || body.op !== 'create') return undefined;
  return { id: env.id, type: body.type, clock: env.clock, author: env.author, seq: env.seq, fields: body.fields as never };
}

export class AuthorityHub implements AuthorityView {
  private auths = new Map<string, Authority>();
  private loaded = new Set<string>();
  private loading = new Map<string, Promise<Authority>>();
  private pending = new Map<string, ControlEvent[]>();
  /** Highest applied (clock, seq) per author per Space, for the rebuild triggers. */
  private maxApplied = new Map<string, { clock: string; seq: number }>();
  private spaceList = new Set<string>();
  private unsub: (() => void) | undefined;
  /** Called after a control event was folded. Set by the service. */
  onControl: (e: ControlApplied) => void = () => undefined;
  /** Called for every applied key grant (they are not part of the fold). */
  onGrant: (space: string, ev: ControlEvent<typeof SYS.keygrant>, local: boolean) => void = () => undefined;
  /** Called for every applied non-control packet. */
  onData: (space: string, env: DataPacketEnvelope) => void = () => undefined;

  constructor(
    private readonly core: SyncCore,
    private readonly opts: AuthorityOptions = {},
  ) {}

  start(): void {
    this.unsub = this.core.onApplied(({ env, body, source }) => this.applied(env, body, source === 'local'));
  }

  stop(): void {
    this.unsub?.();
  }

  authority(space: string): Authority {
    let a = this.auths.get(space);
    if (!a) this.auths.set(space, (a = new Authority(space, this.opts)));
    return a;
  }

  isLoaded(space: string): boolean {
    return this.loaded.has(space);
  }

  /** Spaces that have control events or were touched. */
  spaces(): string[] {
    return [...this.spaceList];
  }

  ensure(space: string): Promise<Authority> {
    this.spaceList.add(space);
    if (this.loaded.has(space)) return Promise.resolve(this.authority(space));
    let p = this.loading.get(space);
    if (!p) {
      p = this.load(space).finally(() => this.loading.delete(space));
      this.loading.set(space, p);
    }
    return p;
  }

  private async load(space: string): Promise<Authority> {
    this.pending.set(space, []);
    const items = await this.core.scanApplied(space, { typePrefix: SYS_PREFIX });
    const a = this.authority(space);
    a.load(items.map((i) => toControlEvent(i.env, i.body)).filter((e): e is ControlEvent => !!e));
    for (const ev of this.pending.get(space) ?? []) a.add(ev);
    this.pending.delete(space);
    this.loaded.add(space);
    return a;
  }

  /** Throw away the folded state and read it again from the log (after a rebuild). */
  async reload(space: string): Promise<Authority> {
    this.loaded.delete(space);
    return this.ensure(space);
  }

  maxAppliedOf(space: string, author: string): { clock: string; seq: number } | undefined {
    return this.maxApplied.get(`${space}\u0000${author}`);
  }

  /** The share (in any Space) that an object belongs to now. Used by the compaction pin. */
  shareOfObjAnywhere(obj: string): string | undefined {
    for (const a of this.auths.values()) {
      const s = a.shareOfObj(obj);
      if (s) return s.id;
    }
    return undefined;
  }

  private applied(env: DataPacketEnvelope, body: PacketBody, local: boolean): void {
    this.spaceList.add(env.space);
    const ev = toControlEvent(env, body);
    if (!ev) {
      const k = `${env.space}\u0000${env.author}`;
      const cur = this.maxApplied.get(k);
      this.maxApplied.set(k, { clock: cur && cur.clock > env.clock ? cur.clock : env.clock, seq: Math.max(cur?.seq ?? 0, env.seq) });
      if (!body.type.startsWith(SYS_PREFIX)) this.onData(env.space, env);
      return;
    }
    if (ev.type === SYS.keygrant) {
      this.onGrant(env.space, ev as ControlEvent<typeof SYS.keygrant>, local);
      return;
    }
    if (!this.loaded.has(env.space)) {
      // a load is in flight or has not started: the load reads the log (which already holds this packet) or replays this
      this.pending.get(env.space)?.push(ev);
      return;
    }
    const r = this.authority(env.space).add(ev);
    if (r.added) this.onControl({ space: env.space, event: ev, retroactive: r.retroactive, newInert: r.newInert, local });
  }
}
