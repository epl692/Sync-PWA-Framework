/**
 * The default Identity Provider: invite links and QR codes, sealed handshakes over the core's `identity/1`
 * channel (the relay online, a WebRTC link offline), and device linking. See specs/002-spaces-security-identity
 * contracts/join-protocol.md.
 */

import { b64urlDecode, b64urlEncode, base32 } from '@sync/core';
import {
  JoinDeniedError,
  concat,
  deviceIdFromSignPub,
  sha256,
  utf8,
  type DeviceBinding,
  type DevicePublic,
  type IdentityProvider,
  type InviteArtifact,
  type InviteSpec,
  type JoinGrantData,
  type LinkGrantData,
  type LocalDevice,
  type ProviderHost,
  type Role,
  type UserSession,
} from '@sync/spaces';
import {
  CHAIN_KIND,
  GENESIS_KIND,
  chainBinding,
  extendChain,
  issueGenesis,
  parseChain,
  verifyDeviceBinding,
  type Chain,
} from './binding';
import {
  decodeArtifact,
  encodeArtifact,
  proofOf,
  sameBytes,
  sasOf,
  secretHash,
  type ArtifactData,
} from './invite';
import { openSealed, sealTo } from './seal';

export interface InviteProviderOptions {
  /** Where invite links point. Default: the page's own URL, or "sync://join" outside a browser. */
  baseUrl?: string;
  /** How long an Owner waits for a human to approve a join (default 5 minutes). */
  approvalTimeoutMs?: number;
  /** How long the joiner waits for an answer before any pending notice (default 30 seconds). */
  joinTimeoutMs?: number;
  /** How long a device-link code stays valid (default 10 minutes). */
  linkTtlMs?: number;
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_INVITE_DAYS = 30;
const BINDING_KEY = 'binding';
const dec = new TextDecoder();
const json = (o: unknown) => utf8.encode(JSON.stringify(o));
const parse = (b: Uint8Array): any => {
  try {
    return JSON.parse(dec.decode(b));
  } catch {
    return undefined;
  }
};
const isDenyReason = (r: unknown): r is JoinDeniedError['reason'] =>
  ['expired', 'used-up', 'revoked', 'declined', 'bad-proof', 'unknown', 'replayed', 'timeout'].includes(
    r as string,
  );

function defaultBase(): string {
  const loc = (globalThis as { location?: { origin?: string; pathname?: string } }).location;
  return loc?.origin && loc.origin !== 'null' ? `${loc.origin}${loc.pathname ?? '/'}` : 'sync://join';
}

const wireDevice = (d: DevicePublic) => ({
  deviceId: d.deviceId,
  signPub: b64urlEncode(d.signPub),
  agreePub: b64urlEncode(d.agreePub),
  name: d.name,
});
const unwireDevice = (d: any): DevicePublic => ({
  deviceId: d.deviceId,
  signPub: b64urlDecode(d.signPub),
  agreePub: b64urlDecode(d.agreePub),
  name: d.name,
});

export function createInviteProvider(opts: InviteProviderOptions = {}): IdentityProvider {
  const approvalTimeoutMs = opts.approvalTimeoutMs ?? 5 * 60_000;
  const joinTimeoutMs = opts.joinTimeoutMs ?? 30_000;
  const linkTtlMs = opts.linkTtlMs ?? 10 * 60_000;
  let host: ProviderHost;
  let disposeChannel: (() => void) | undefined;
  /** Replies we are waiting for, by request nonce. */
  const waiting = new Map<string, (msg: any) => void>();
  /** Link codes this device has shown and not yet consumed, by nonce. */
  const openLinks = new Map<string, (peerKey: string, offer: any) => Promise<void>>();

  const me = (): LocalDevice => host.device();
  const meta = (d: LocalDevice): DevicePublic => ({
    deviceId: d.deviceId,
    signPub: d.signPub,
    agreePub: d.agreePub,
    name: d.name,
  });

  async function ownChain(user: string): Promise<Chain | undefined> {
    if (user === me().deviceId) return undefined; // first device: the chain starts here
    const raw = await host.store.get(BINDING_KEY);
    return raw ? parseChain({ kind: CHAIN_KIND, proof: raw }) : undefined;
  }

  async function sendSealed(
    peerKey: string,
    toAgreePub: Uint8Array,
    msg: unknown,
    context: string,
    space: string,
  ): Promise<void> {
    await host.channel.send(peerKey, await sealTo(toAgreePub, json(msg), context), { space });
  }

  // ---- inbound ----

  async function onMessage(peerKey: string, payload: Uint8Array): Promise<void> {
    const device = me();
    // a reply to something we asked
    for (const ctx of ['join-reply', 'link-reply']) {
      const opened = await openSealed(device, payload, ctx);
      if (opened) {
        const m = parse(opened);
        if (m && typeof m.nonce === 'string') waiting.get(m.nonce)?.(m);
        return;
      }
    }
    const req = await openSealed(device, payload, 'join-request');
    if (req) return void (await onJoinRequest(peerKey, parse(req)));
    const offer = await openSealed(device, payload, 'link-offer');
    if (offer) {
      const m = parse(offer);
      if (m && typeof m.nonce === 'string') await openLinks.get(m.nonce)?.(peerKey, m);
    }
  }

  async function onJoinRequest(peerKey: string, m: any): Promise<void> {
    if (
      !m ||
      m.kind !== 'join-request' ||
      typeof m.inviteId !== 'string' ||
      typeof m.space !== 'string' ||
      typeof m.nonce !== 'string' ||
      !m.device ||
      !m.binding
    )
      return;
    let joinerDevice: DevicePublic;
    let nonce: Uint8Array;
    let proof: Uint8Array;
    try {
      joinerDevice = unwireDevice(m.device);
      nonce = b64urlDecode(m.nonce);
      proof = b64urlDecode(m.proof);
    } catch {
      return;
    }
    const reply = (msg: Record<string, unknown>) =>
      sendSealed(peerKey, joinerDevice.agreePub, { ...msg, nonce: m.nonce }, 'join-reply', m.space);
    const deny = (reason: string) => reply({ kind: 'join-deny', reason });

    const stored = await host.secrets.get(m.inviteId);
    if (!stored) return; // another device made this invite: stay silent
    if (stored.seenNonces.includes(m.nonce)) return; // a replay: say nothing
    if ((await deviceIdFromSignPub(joinerDevice.signPub)) !== joinerDevice.deviceId)
      return void (await deny('bad-proof'));
    if (!sameBytes(await proofOf(stored.secret, joinerDevice.signPub, nonce), proof))
      return void (await deny('bad-proof'));
    // Check-and-remember with no await in between, so two copies of one request racing here cannot both pass.
    const latest = (await host.secrets.get(m.inviteId)) ?? stored;
    if (latest.seenNonces.includes(m.nonce)) return;
    latest.seenNonces.push(m.nonce);
    host.secrets.put(m.inviteId, latest).catch(() => undefined);

    const status = await host.inviteStatus(m.space, m.inviteId);
    if (!status.ok) return void (await deny(status.reason));
    const binding: DeviceBinding = { kind: m.binding.kind, proof: b64urlDecode(m.binding.proof) };
    if (typeof m.user !== 'string' || !(await verifyDeviceBinding(m.user, joinerDevice, binding)))
      return void (await deny('bad-proof'));

    if (status.approval === 'required') {
      const sas = await sasOf(joinerDevice.signPub, me().signPub);
      await reply({ kind: 'join-pending', sas });
      const approved = await Promise.race([
        host.approve({
          space: m.space,
          inviteId: m.inviteId,
          role: status.role,
          deviceName: joinerDevice.name,
          sas,
        }),
        new Promise<boolean>((r) => setTimeout(() => r(false), approvalTimeoutMs)),
      ]);
      if (!approved) return void (await deny('declined'));
    }
    let data: JoinGrantData;
    try {
      data = await host.admit(m.space, m.inviteId, {
        user: m.user,
        device: joinerDevice,
        binding,
        displayName: m.displayName,
      });
    } catch (e) {
      return void (await deny(e instanceof JoinDeniedError ? e.reason : 'unknown'));
    }
    await reply({ kind: 'join-grant', data });
  }

  function expect(
    nonce: string,
    firstTimeoutMs: number,
    onPending?: (m: any) => number | void,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let timer = setTimeout(fail, firstTimeoutMs);
      function fail() {
        waiting.delete(nonce);
        reject(new JoinDeniedError('timeout'));
      }
      waiting.set(nonce, (msg) => {
        if (msg.kind === 'join-pending') {
          const extend = onPending?.(msg);
          if (extend) {
            clearTimeout(timer);
            timer = setTimeout(fail, extend);
          }
          return;
        }
        clearTimeout(timer);
        waiting.delete(nonce);
        resolve(msg);
      });
    });
  }

  const self: IdentityProvider = {
    id: 'invite-qr',
    bindingKinds: [GENESIS_KIND, CHAIN_KIND],

    async init(h) {
      host = h;
      disposeChannel = host.channel.onMessage((p, b) => void onMessage(p, b));
    },

    async dispose() {
      disposeChannel?.();
      waiting.clear();
      openLinks.clear();
    },

    async createUser(o) {
      const d = me();
      return { user: d.deviceId, displayName: o?.displayName, device: meta(d) };
    },

    verifyBinding: (user, device, binding) => verifyDeviceBinding(user, device, binding),

    async issueBinding(session, device) {
      const mine = me();
      if (device.deviceId === mine.deviceId) {
        if (session.user === mine.deviceId) return issueGenesis(mine);
        const raw = await host.store.get(BINDING_KEY);
        if (!raw) throw new Error('this device has no binding yet; link it to its user first');
        return { kind: CHAIN_KIND, proof: raw };
      }
      return chainBinding(await extendChain(session.user, mine, await ownChain(session.user), device));
    },

    // ---- invites ----

    async createInvite(session, spec: InviteSpec): Promise<InviteArtifact> {
      const now = host.now();
      if (!Number.isInteger(spec.maxUses) || spec.maxUses < 1)
        throw new Error('an invite needs maxUses of at least 1');
      if (!(spec.expiresAt > now)) throw new Error('an invite must expire in the future');
      if (spec.expiresAt - now > MAX_INVITE_DAYS * DAY)
        throw new Error(`an invite may be valid for at most ${MAX_INVITE_DAYS} days`);
      const inviteId = base32(host.random(10));
      const secret = host.random(24);
      const d = me();
      await host.secrets.put(inviteId, { secret, seenNonces: [] });
      await host.registerInvite({
        space: spec.space,
        inviteId,
        role: spec.role,
        expiresAt: spec.expiresAt,
        maxUses: spec.maxUses,
        secretHash: await secretHash(secret),
        approval: spec.approval ?? 'required',
      });
      const art: ArtifactData = {
        v: 1,
        i: inviteId,
        s: spec.space,
        k: b64urlEncode(secret),
        r: spec.role,
        e: spec.expiresAt,
        d: d.deviceId,
        sp: b64urlEncode(d.signPub),
        ap: b64urlEncode(d.agreePub),
      };
      void session;
      return { inviteId, expiresAt: spec.expiresAt, ...encodeArtifact(art, opts.baseUrl ?? defaultBase()) };
    },

    async revokeInvite(_session, space, inviteId) {
      await host.revokeInviteRecord(space, inviteId);
    },

    async acceptInvite(session, artifact, o) {
      const a = await decodeArtifact(artifact);
      if (!a) throw new JoinDeniedError('unknown');
      if (host.now() >= a.e) throw new JoinDeniedError('expired');
      const device = me();
      const inviterSign = b64urlDecode(a.sp);
      const inviterAgree = b64urlDecode(a.ap);
      const nonce = host.random(16);
      const nonceB64 = b64urlEncode(nonce);
      const binding = await self.issueBinding(session, meta(device));
      const waitFor = expect(nonceB64, o?.timeoutMs ?? joinTimeoutMs, (m) => {
        o?.onSas?.(m.sas);
        return approvalTimeoutMs + 30_000; // a human is deciding
      });
      host.channel.setRoutes([a.s]);
      const sealed = await sealTo(
        inviterAgree,
        json({
          kind: 'join-request',
          inviteId: a.i,
          space: a.s,
          nonce: nonceB64,
          proof: b64urlEncode(await proofOf(b64urlDecode(a.k), device.signPub, nonce)),
          user: session.user,
          displayName: session.displayName,
          device: wireDevice(meta(device)),
          binding: { kind: binding.kind, proof: b64urlEncode(binding.proof) },
        }),
        'join-request',
      );
      void inviterSign;
      await host.channel.broadcast(sealed, { space: a.s });
      const reply = await waitFor;
      if (reply.kind === 'join-deny')
        throw new JoinDeniedError(isDenyReason(reply.reason) ? reply.reason : 'unknown');
      const data = reply.data as JoinGrantData;
      await host.completeJoin(data);
      return { space: data.space, role: data.role as Role };
    },

    // ---- linking another device ----

    async beginLink(session: UserSession) {
      const d = me();
      const nonce = b64urlEncode(host.random(16));
      const code = `sync-link:${b64urlEncode(json({ v: 1, n: nonce, user: session.user, d: d.deviceId, sp: b64urlEncode(d.signPub), ap: b64urlEncode(d.agreePub) }))}`;
      const done = new Promise<{ device: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          openLinks.delete(nonce);
          reject(new Error('the device link code expired'));
        }, linkTtlMs);
        openLinks.set(nonce, async (peerKey, offer) => {
          openLinks.delete(nonce); // single use
          clearTimeout(timer);
          try {
            const device = unwireDevice(offer.device);
            if ((await deviceIdFromSignPub(device.signPub)) !== device.deviceId)
              throw new Error('device ID does not match its key');
            const sas = await sasOf(device.signPub, d.signPub);
            if (!(await host.approveLink(device, sas))) throw new Error('the link was declined');
            const chain = await extendChain(session.user, d, await ownChain(session.user), device);
            const binding = chainBinding(chain);
            const data = await host.linkNewDevice(device, binding);
            await sendSealed(
              peerKey,
              device.agreePub,
              {
                kind: 'link-accept',
                nonce,
                data,
                binding: { kind: binding.kind, proof: b64urlEncode(binding.proof) },
              },
              'link-reply',
              '*',
            );
            resolve({ device: device.deviceId });
          } catch (e) {
            // tell the new device at once, instead of leaving it to time out
            const peerDevice = (() => {
              try {
                return unwireDevice(offer.device);
              } catch {
                return undefined;
              }
            })();
            if (peerDevice)
              await sendSealed(
                peerKey,
                peerDevice.agreePub,
                { kind: 'link-deny', nonce, reason: (e as Error).message },
                'link-reply',
                '*',
              ).catch(() => undefined);
            reject(e);
          }
        });
      });
      done.catch(() => undefined);
      return { code, done };
    },

    async completeLink(code, o) {
      const c = code.startsWith('sync-link:')
        ? parse(b64urlDecode(code.slice('sync-link:'.length)))
        : undefined;
      if (!c || c.v !== 1 || typeof c.n !== 'string' || typeof c.user !== 'string')
        throw new Error('not a device link code');
      const existingSign = b64urlDecode(c.sp);
      if ((await deviceIdFromSignPub(existingSign)) !== c.d)
        throw new Error('the device link code is damaged');
      const d = me();
      o?.onSas?.(await sasOf(d.signPub, existingSign)); // the same words the existing device shows for approval
      const waitFor = expect(c.n, o?.timeoutMs ?? 30_000);
      const sealed = await sealTo(
        b64urlDecode(c.ap),
        json({ kind: 'link-offer', nonce: c.n, device: wireDevice(meta(d)) }),
        'link-offer',
      );
      await host.channel.broadcast(sealed);
      const reply = await waitFor;
      if (reply.kind === 'link-deny')
        throw new Error(`the existing device refused the link: ${reply.reason}`);
      const binding: DeviceBinding = { kind: reply.binding.kind, proof: b64urlDecode(reply.binding.proof) };
      if (!(await verifyDeviceBinding(c.user, meta(d), binding)))
        throw new Error('the existing device sent evidence that does not verify');
      await host.store.put(BINDING_KEY, binding.proof);
      const data = reply.data as LinkGrantData;
      if (data.user !== c.user) throw new Error('the existing device named another user');
      await host.completeLink(data);
      return { user: data.user, displayName: data.displayName, device: meta(d) };
    },
  };
  return self;
}

void concat;
void sha256;
