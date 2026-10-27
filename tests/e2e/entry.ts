// Browser entry for e2e tests: exposes the pieces tests drive from page.evaluate().
import { createIndexedDbStorage, createSyncCore } from '@sync/core';
// the codec file only: the test kit's index also pulls in Node-only helpers (the relay hub)
import { PlaintextCodec } from '../../packages/testkit/src/plaintextCodec';
import { createWebSocketTransport } from '@sync/transport-websocket';
import { createWebRtcTransport } from '@sync/transport-webrtc';
import { indexedDbKeyDb, openSecureCore, assertSecureCore } from '@sync/spaces';
import { createInviteProvider, qrToSvg } from '@sync/identity-invite';
import { createBlobs, createIndexedDbBlobStorage } from '@sync/blobs';

/** A fully encrypted node (spec 002): device keys in IndexedDB, the default invite/QR provider, WebSocket and/or WebRTC. */
async function openSecureNode(name: string, o: { url?: string; rtc?: boolean; approve?: boolean } = {}) {
  const storage = await createIndexedDbStorage({ name: `${name}-data` });
  const requests: unknown[] = [];
  const { core, spaces } = await openSecureCore({
    keyDb: await indexedDbKeyDb({ name: `${name}-keys` }),
    provider: createInviteProvider({ baseUrl: location.origin + '/' }),
    approveJoin: (req) => (requests.push(req), o.approve ?? true),
    rotationGraceMs: 200,
    core: { storage },
  });
  assertSecureCore(core);
  const rtc = o.rtc ? createWebRtcTransport({}) : undefined;
  if (rtc) core.addTransport(rtc);
  if (o.url) core.addTransport(createWebSocketTransport({ url: o.url }));
  await spaces.signUp(name);
  return { core, spaces, rtc, requests };
}

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

/** Attachments (spec 004) on a secure node, with the blob store in its own IndexedDB database. */
async function openBlobs(node: { core: any; spaces: any }, name: string, config: Record<string, unknown> = {}) {
  return createBlobs({ core: node.core, keys: node.spaces.blobKeys, storage: await createIndexedDbBlobStorage({ name: `${name}-blobs` }), config });
}

(window as any).__sync = { openCore, openSyncedCore, openRtcCore, createIndexedDbStorage, createSyncCore, PlaintextCodec, openSecureNode, openBlobs, qrToSvg };
