/** Owns the transports and one PeerSession per connected peer. */

import type { Accepted } from '../store/apply';
import type { PeerSummary } from './channel';
import { PeerSession, type SyncEnv } from './session';
import type { Transport } from './transport';

interface Entry {
  transport: Transport;
  unsubs: (() => void)[];
  sessions: Map<string, PeerSession>;
}

export class TransportManager {
  private entries = new Map<string, Entry>();
  private announced = new Set<string>();

  constructor(private readonly env: SyncEnv) {
    env.channels.send = (peerKey, name, space, payload) => {
      const s = this.session(peerKey);
      if (!s) return Promise.reject(new Error(`peer ${peerKey} is not connected`));
      return s.sendChan(name, space, payload);
    };
    env.channels.broadcast = async (name, space, payload) => {
      const all = this.sessions();
      await Promise.all(all.map((s) => s.sendChan(name, space, payload)));
      return all.length;
    };
    env.channels.onRoutesChanged = () => this.sessions().forEach((s) => s.announce());
  }

  private sessions(): PeerSession[] {
    return [...this.entries.values()].flatMap((e) => [...e.sessions.values()]);
  }

  private session(key: string): PeerSession | undefined {
    return this.sessions().find((s) => s.key === key);
  }

  peers(): PeerSummary[] {
    return this.sessions().map((s) => ({ key: s.key, transport: s.key.slice(0, s.key.length - s.peer.id.length - 1), peerId: s.peer.id, label: s.peer.label }));
  }

  add(transport: Transport): void {
    if (this.entries.has(transport.id)) throw new Error(`transport ${transport.id} is already added`);
    const entry: Entry = { transport, unsubs: [], sessions: new Map() };
    this.entries.set(transport.id, entry);
    const emitState = (state: string) => this.env.events.emit({ kind: 'transport:state', transport: transport.id, state });

    entry.unsubs.push(
      transport.on('state', (s) => emitState(s)),
      transport.on('peerConnected', (peer) => {
        entry.sessions.get(peer.id)?.close();
        const s = new PeerSession(this.env, transport, peer);
        entry.sessions.set(peer.id, s);
        s.start();
      }),
      transport.on('peerDisconnected', (peerId) => {
        entry.sessions.get(peerId)?.close();
        entry.sessions.delete(peerId);
      }),
      transport.on('message', (peerId, bytes) => entry.sessions.get(peerId)?.onMessage(bytes)),
      transport.on('error', (err) => this.env.events.emit({ kind: 'packet:rejected', id: '', reason: `${transport.id}: ${err.code}: ${err.message}` })),
    );

    const support = transport.supported();
    if (!support.ok) {
      emitState('unsupported');
      return;
    }
    void transport.start().catch(() => emitState('error'));
  }

  async remove(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    for (const s of e.sessions.values()) s.close();
    for (const u of e.unsubs) u();
    await e.transport.stop();
  }

  list(): ReadonlyArray<{ id: string; state: string }> {
    return [...this.entries.values()].map((e) => ({ id: e.transport.id, state: e.transport.state }));
  }

  /** Called after every accepted packet. Forwards it to peers, honouring the relay setting. */
  onAccepted(a: Accepted): void {
    if (!this.announced.has(a.space)) {
      this.announced.add(a.space);
      for (const e of this.entries.values()) for (const s of e.sessions.values()) s.announce();
    }
    const local = a.source === 'local';
    if (!local && !this.env.relayFor(a.space)) return;
    for (const e of this.entries.values()) {
      for (const s of e.sessions.values()) {
        if (s.key !== a.source) s.offer(a.space, a.id, a.raw);
      }
    }
  }

  /** Seed the set of already-known Spaces so the first packet in an old Space does not re-announce. */
  markKnown(spaces: string[]): void {
    for (const s of spaces) this.announced.add(s);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.entries.keys()]) await this.remove(id);
  }
}
