/**
 * A deliberately simple Identity Provider for tests and as a worked example of the contract (SC-005).
 * Bindings are a fixed token, handshakes are clear JSON on the channel. NOT secure: tests only.
 */

import { b64urlDecode, b64urlEncode, base32 } from '@sync/core';
import {
  JoinDeniedError,
  sha256,
  type DeviceBinding,
  type DevicePublic,
  type IdentityProvider,
  type InviteArtifact,
  type InviteSpec,
  type ProviderHost,
  type Role,
  type UserSession,
} from '@sync/spaces';

const KIND = 'stub-token/1';
const enc = new TextEncoder();
const dec = new TextDecoder();
const DAY = 24 * 60 * 60 * 1000;
const json = (o: unknown) => enc.encode(JSON.stringify(o));
const parse = (b: Uint8Array): any => {
  try {
    return JSON.parse(dec.decode(b));
  } catch {
    return undefined;
  }
};
const token = (user: string, device: string) => enc.encode(`ok|${user}|${device}`);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function createStubIdentityProvider(): IdentityProvider {
  let host: ProviderHost;
  const waiting = new Map<string, (msg: any) => void>();

  async function onMessage(peerKey: string, payload: Uint8Array): Promise<void> {
    const m = parse(payload);
    if (!m || typeof m.kind !== 'string') return;
    if (m.kind === 'join-grant' || m.kind === 'join-deny' || m.kind === 'link-accept') {
      waiting.get(m.nonce)?.(m);
      return;
    }
    if (m.kind === 'join-request') await onJoinRequest(peerKey, m);
  }

  async function deny(peerKey: string, nonce: string, reason: string, space: string) {
    await host.channel.send(peerKey, json({ kind: 'join-deny', nonce, reason }), { space });
  }

  async function onJoinRequest(peerKey: string, m: any): Promise<void> {
    const stored = await host.secrets.get(m.inviteId);
    if (!stored) return; // not the device that created this invite: stay silent
    const status = await host.inviteStatus(m.space, m.inviteId);
    if (!status.ok) return deny(peerKey, m.nonce, status.reason, m.space);
    if (stored.seenNonces.includes(m.nonce)) return deny(peerKey, m.nonce, 'replayed', m.space);
    if (!sameBytes(await sha256(b64urlDecode(m.secret)), status.secretHash)) return deny(peerKey, m.nonce, 'bad-proof', m.space);
    stored.seenNonces.push(m.nonce);
    await host.secrets.put(m.inviteId, stored);
    const joiner = {
      user: m.user,
      device: { deviceId: m.device.deviceId, signPub: b64urlDecode(m.device.signPub), agreePub: b64urlDecode(m.device.agreePub), name: m.device.name },
      binding: { kind: m.binding.kind, proof: b64urlDecode(m.binding.proof) },
      displayName: m.displayName,
    };
    if (!(await self.verifyBinding(joiner.user, joiner.device, joiner.binding, []))) return deny(peerKey, m.nonce, 'bad-proof', m.space);
    if (status.approval === 'required') {
      const sas = m.device.deviceId.slice(0, 5);
      if (!(await host.approve({ space: m.space, inviteId: m.inviteId, role: status.role, deviceName: m.device.name, sas }))) return deny(peerKey, m.nonce, 'declined', m.space);
    }
    const data = await host.admit(m.space, m.inviteId, joiner);
    await host.channel.send(peerKey, json({ kind: 'join-grant', nonce: m.nonce, data }), { space: m.space });
  }

  function request<T>(nonce: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        waiting.delete(nonce);
        reject(new JoinDeniedError('timeout'));
      }, timeoutMs);
      waiting.set(nonce, (msg) => {
        clearTimeout(t);
        waiting.delete(nonce);
        resolve(msg);
      });
    });
  }

  const self: IdentityProvider = {
    id: 'stub',
    bindingKinds: [KIND],
    async init(h) {
      host = h;
      host.channel.onMessage((p, b) => void onMessage(p, b));
    },
    async createUser(opts) {
      const d = host.device();
      return { user: `stub-${d.deviceId}`, displayName: opts?.displayName, device: { deviceId: d.deviceId, signPub: d.signPub, agreePub: d.agreePub, name: d.name } };
    },
    async verifyBinding(user, device, binding) {
      return binding.kind === KIND && sameBytes(binding.proof, token(user, device.deviceId));
    },
    async issueBinding(session, device): Promise<DeviceBinding> {
      return { kind: KIND, proof: token(session.user, device.deviceId) };
    },
    async createInvite(session, spec: InviteSpec): Promise<InviteArtifact> {
      const now = host.now();
      if (!Number.isInteger(spec.maxUses) || spec.maxUses < 1) throw new Error('maxUses must be at least 1');
      if (!(spec.expiresAt > now)) throw new Error('expiresAt must be in the future');
      if (spec.expiresAt - now > 30 * DAY) throw new Error('expiresAt is more than 30 days away');
      const inviteId = base32(host.random(10));
      const secret = host.random(16);
      await host.secrets.put(inviteId, { secret, seenNonces: [] });
      await host.registerInvite({ space: spec.space, inviteId, role: spec.role, expiresAt: spec.expiresAt, maxUses: spec.maxUses, secretHash: await sha256(secret), approval: spec.approval ?? 'required' });
      const body = b64urlEncode(json({ inviteId, space: spec.space, secret: b64urlEncode(secret), role: spec.role, expiresAt: spec.expiresAt, inviter: session.device.deviceId }));
      return { inviteId, url: `stub://join#${body}`, qrPayload: `stub://join#${body}`, expiresAt: spec.expiresAt };
    },
    async revokeInvite(_s, space, inviteId) {
      await host.revokeInviteRecord(space, inviteId);
    },
    async acceptInvite(session, artifact, opts) {
      const a = parse(b64urlDecode(artifact.split('#')[1] ?? ''));
      if (!a?.inviteId) throw new JoinDeniedError('unknown');
      const nonce = b64urlEncode(host.random(12));
      host.channel.setRoutes([a.space]);
      const device = session.device;
      const binding = await self.issueBinding(session, device);
      const waitFor = request(nonce, opts?.timeoutMs ?? 5000);
      await host.channel.broadcast(
        json({
          kind: 'join-request',
          nonce,
          inviteId: a.inviteId,
          space: a.space,
          secret: a.secret,
          user: session.user,
          displayName: session.displayName,
          device: { deviceId: device.deviceId, signPub: b64urlEncode(device.signPub), agreePub: b64urlEncode(device.agreePub), name: device.name },
          binding: { kind: binding.kind, proof: b64urlEncode(binding.proof) },
        }),
        { space: a.space },
      );
      const reply = await waitFor;
      if (reply.kind === 'join-deny') throw new JoinDeniedError(reply.reason);
      const data = { ...reply.data, grants: reply.data.grants ?? [] };
      await host.completeJoin(data);
      return { space: data.space, role: data.role as Role };
    },
    async beginLink(session: UserSession) {
      const nonce = b64urlEncode(host.random(12));
      const code = `stublink:${b64urlEncode(json({ nonce, from: session.device.deviceId }))}`;
      const done = new Promise<{ device: string }>((resolve) => {
        host.channel.onMessage(async (peerKey, payload) => {
          const m = parse(payload);
          if (m?.kind !== 'link-offer' || m.nonce !== nonce) return;
          const device: DevicePublic = { deviceId: m.device.deviceId, signPub: b64urlDecode(m.device.signPub), agreePub: b64urlDecode(m.device.agreePub), name: m.device.name };
          const binding = await self.issueBinding(session, device);
          const data = await host.linkNewDevice(device, binding);
          await host.channel.send(peerKey, json({ kind: 'link-accept', nonce, data, binding: { kind: binding.kind, proof: b64urlEncode(binding.proof) } }));
          resolve({ device: device.deviceId });
        });
      });
      return { code, done };
    },
    async completeLink(code) {
      const c = parse(b64urlDecode(code.replace(/^stublink:/, '')));
      if (!c?.nonce) throw new Error('not a link code');
      const d = host.device();
      const waitFor = request(c.nonce, 5000);
      await host.channel.broadcast(json({ kind: 'link-offer', nonce: c.nonce, device: { deviceId: d.deviceId, signPub: b64urlEncode(d.signPub), agreePub: b64urlEncode(d.agreePub), name: d.name } }));
      const reply = await waitFor;
      await host.completeLink(reply.data);
      return { user: reply.data.user, displayName: reply.data.displayName, device: { deviceId: d.deviceId, signPub: d.signPub, agreePub: d.agreePub, name: d.name } };
    },
  };
  return self;
}
