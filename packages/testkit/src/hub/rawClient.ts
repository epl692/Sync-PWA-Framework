/**
 * RawClient: a hand-driven link/1 client for adversarial and protocol tests (spec 005). It runs the real handshake and then lets a
 * test send any control or core message, valid or not, and watch what the Hub answers. Not for apps.
 */

import {
  LinkChannel,
  b64uEncode,
  startClientHandshake,
  type ControlMessage,
  type HubInfo,
  LINK_VERSIONS,
  parseInfo,
} from '@sync/transport-bluetooth/link';
import { openGattLink, requestHub, type GattLink } from '@sync/transport-bluetooth';
import type { FixtureProofs } from './linkFixture';
import type { MemoryBleLink } from '../ble/memoryBleLink';

type Control = { t: string } & Record<string, unknown>;

export class RawClient {
  controls: Control[] = [];
  core: Uint8Array[] = [];
  strikes: string[] = [];
  closed = false;
  info!: HubInfo;
  nc!: Uint8Array;
  nh!: Uint8Array;
  hubFingerprint!: Uint8Array;
  channel!: LinkChannel;
  private waiters: Array<{ types: string[]; resolve: (m: Control) => void }> = [];

  private constructor(readonly gatt: GattLink) {}

  /** Connect the radio and read INFO; no handshake yet. */
  static async open(link: MemoryBleLink, air?: Parameters<MemoryBleLink['bluetooth']>[0]): Promise<RawClient> {
    const bt = link.bluetooth(air);
    const device = await requestHub(bt as never);
    const g = await openGattLink(device as never);
    const c = new RawClient(g);
    c.info = parseInfo(await g.info())!;
    g.onDisconnect(() => void (c.closed = true));
    return c;
  }

  private build(): void {
    this.channel = new LinkChannel({
      maxMessageBytes: 4 * 1024 * 1024,
      write: (f) => this.gatt.write(f),
      now: () => Date.now(),
      handlers: {
        plain: (m) => void (this.plain?.(m), (this.plain = undefined)),
        control: (m) => {
          this.controls.push(m);
          const i = this.waiters.findIndex((w) => w.types.includes(m.t));
          if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
        },
        core: (b) => void this.core.push(b),
        strike: (r) => void this.strikes.push(r),
      },
    });
    this.gatt.onFrame((f) => void this.channel.onFrame(f));
  }

  private plain: ((m: Uint8Array) => void) | undefined;

  /** Run the secure handshake. Returns true if the Hub answered with keys, false if it answered busy. */
  async handshake(): Promise<boolean> {
    this.build();
    const hs = await startClientHandshake(LINK_VERSIONS);
    const ack = new Promise<Uint8Array>((r) => (this.plain = r));
    this.channel.sendPlain(hs.hello);
    const done = await hs.finish(await ack);
    if ('busy' in done) return false;
    this.channel.setSession(done.session);
    this.nc = done.nc;
    this.nh = done.nh;
    this.hubFingerprint = done.hubFingerprint;
    return true;
  }

  /** A correct `auth` message for the given proofs (or tampered through `over`). */
  async authMessage(proofs: FixtureProofs, over: { spaces?: Array<{ space: string; epoch: number; sig?: string }>; claim?: boolean } = {}): Promise<ControlMessage> {
    const offered: Array<{ space: string; epoch: number; sig?: string }> = over.spaces ?? (await proofs.spaces());
    const spaces = await Promise.all(
      offered.map(async (s) => ({
        space: s.space,
        epoch: s.epoch,
        sig: s.sig ?? b64uEncode(await proofs.proveSpace({ space: s.space, epoch: s.epoch, hubFingerprint: this.hubFingerprint, nc: this.nc, nh: this.nh })),
      })),
    );
    const dev = await proofs.proveDevice({ hubFingerprint: this.hubFingerprint, nc: this.nc, nh: this.nh });
    const claim = over.claim ? await Promise.all(offered.map(async (s) => ({ space: s.space, epoch: s.epoch, accessPublicKey: b64uEncode(await proofs.accessPublic(s.space, s.epoch)) }))) : undefined;
    return { t: 'auth', device: dev.device, devicePub: b64uEncode(dev.publicKey), devSig: b64uEncode(dev.sig), name: dev.name, spaces, ...(claim ? { claim } : {}) };
  }

  /** Send a correct auth and wait for the Hub's first verdict. */
  async auth(proofs: FixtureProofs, over?: Parameters<RawClient['authMessage']>[1], timeoutMs = 3000): Promise<Control> {
    const reply = this.waitControl(['auth-ok', 'pending', 'reject'], timeoutMs);
    await this.channel.sendControl(await this.authMessage(proofs, over));
    return reply;
  }

  waitControl(types: string[], timeoutMs = 3000): Promise<Control> {
    const existing = this.controls.find((m) => types.includes(m.t));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${types.join('/')}`)), timeoutMs);
      this.waiters.push({
        types,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  sendControl(m: ControlMessage | Record<string, unknown>): Promise<void> {
    return this.channel.sendControl(m as ControlMessage);
  }
  sendCore(b: Uint8Array): Promise<void> {
    return this.channel.sendCore(b);
  }
  /** A raw frame, bypassing the link (for malformed-frame tests). */
  rawFrame(b: Uint8Array): Promise<void> {
    return this.gatt.write(b);
  }
  disconnect(): void {
    this.gatt.close();
  }
  async waitClosed(ms = 3000): Promise<void> {
    const start = Date.now();
    while (!this.closed) {
      if (Date.now() - start > ms) throw new Error('the Hub did not close the connection');
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
