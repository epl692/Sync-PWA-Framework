/** A fake desktop sidecar: speaks the JSON-lines protocol on top of any `BleBridge` (here the simulator), so the client side can be tested without a radio. */

import type { BleBridge, BleBridgeEvents } from '@sync/hub-core';

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface FakeSidecar {
  /** What the Hub core sees: write lines in, receive lines out. */
  proc: { write(line: string): void; onLine(cb: (line: string) => void): void; onExit(cb: () => void): void; kill(): void };
  /** Lines the Hub core sent, parsed. */
  received: Array<Record<string, unknown>>;
  /** Make the sidecar die. */
  crash(): void;
  /** Send an arbitrary raw line to the Hub core. */
  raw(line: string): void;
  killed: boolean;
}

export function createFakeSidecar(bridge: BleBridge, o: { version?: number; bridgeName?: string; sayHello?: boolean } = {}): FakeSidecar {
  let toCore: (l: string) => void = () => undefined;
  let exit: () => void = () => undefined;
  const received: Array<Record<string, unknown>> = [];
  const send = (o2: Record<string, unknown>) => queueMicrotask(() => toCore(JSON.stringify(o2)));
  const events: Array<keyof BleBridgeEvents> = ['connected', 'mtu', 'write', 'disconnected', 'state', 'seen', 'notify'];
  for (const e of events) {
    bridge.on(e, ((...a: unknown[]) => {
      if (e === 'connected') send({ event: e, conn: a[0], mtu: (a[1] as { mtu: number }).mtu });
      else if (e === 'mtu') send({ event: e, conn: a[0], mtu: a[1] });
      else if (e === 'write' || e === 'notify') send({ event: e, conn: a[0], frame: b64(a[1] as Uint8Array) });
      else if (e === 'disconnected') send({ event: e, conn: a[0], reason: a[1] });
      else if (e === 'state') send({ event: e, state: a[0] });
      else if (e === 'seen') send({ event: e, ...(a[0] as object) });
    }) as never);
  }
  const fake: FakeSidecar = {
    received,
    killed: false,
    crash() {
      exit();
    },
    raw: (l) => toCore(l),
    proc: {
      write(line) {
        const m = JSON.parse(line) as Record<string, unknown>;
        received.push(m);
        const id = m.id as number;
        const ok = (extra: Record<string, unknown> = {}) => send({ id, ok: true, ...extra });
        const bad = (e: unknown) => send({ id, ok: false, code: (e as { code?: string }).code ?? 'bridge-failed', message: (e as Error).message });
        const run = async () => {
          switch (m.op) {
            case 'support': {
              const s = await bridge.support();
              return ok({ peripheral: s.peripheral, central: s.central });
            }
            case 'startAdvertising':
              await bridge.startAdvertising({ ...(m as unknown as Record<string, unknown>), info: unb64(m.info as string) } as never);
              return ok();
            case 'setInfo':
              await bridge.setInfo(unb64(m.info as string));
              return ok();
            case 'stopAdvertising':
              await bridge.stopAdvertising();
              return ok();
            case 'notify':
              await bridge.notify(m.conn as string, unb64(m.frame as string));
              return ok();
            case 'disconnect':
              await bridge.disconnect(m.conn as string);
              return ok();
            case 'startScan':
              await bridge.startScan(m.serviceUuid as string);
              return ok();
            case 'stopScan':
              await bridge.stopScan();
              return ok();
            case 'connect': {
              const r = await bridge.connect(m.address as string);
              return ok({ conn: r.conn, mtu: r.mtu, info: b64(r.info) });
            }
            case 'write':
              await bridge.write(m.conn as string, unb64(m.frame as string));
              return ok();
            case 'close':
              await bridge.close();
              return ok();
            default:
              return send({ id, ok: false, code: 'unknown-op', message: `unknown op ${String(m.op)}` });
          }
        };
        void run().catch(bad);
      },
      onLine(cb) {
        toCore = cb;
        if (o.sayHello !== false) queueMicrotask(() => toCore(JSON.stringify({ event: 'hello', bridge: o.bridgeName ?? 'fake', version: o.version ?? 1 })));
      },
      onExit(cb) {
        exit = cb;
      },
      kill() {
        fake.killed = true;
      },
    },
  };
  return fake;
}
