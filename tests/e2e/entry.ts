// Browser entry for e2e tests: exposes the pieces tests drive from page.evaluate().
import { createIndexedDbStorage, createSyncCore } from '@sync/core';
import { PlaintextCodec } from '@sync/testkit';
import { createWebSocketTransport } from '@sync/transport-websocket';
import { createWebRtcTransport } from '@sync/transport-webrtc';

async function openCore(dbName: string) {
  const storage = await createIndexedDbStorage({ name: dbName });
  return createSyncCore({ storage, codecs: [new PlaintextCodec()] });
}

async function openSyncedCore(dbName: string, url: string, spaces: string[]) {
  const storage = await createIndexedDbStorage({ name: dbName });
  const core = await createSyncCore({ storage, codecs: [new PlaintextCodec()], spaces });
  core.addTransport(createWebSocketTransport({ url }));
  return core;
}

async function openRtcCore(dbName: string, spaces: string[]) {
  const storage = await createIndexedDbStorage({ name: dbName });
  const core = await createSyncCore({ storage, codecs: [new PlaintextCodec()], spaces });
  const rtc = createWebRtcTransport({});
  core.addTransport(rtc);
  return { core, rtc };
}

(window as any).__sync = { openCore, openSyncedCore, openRtcCore, createIndexedDbStorage, createSyncCore, PlaintextCodec };
