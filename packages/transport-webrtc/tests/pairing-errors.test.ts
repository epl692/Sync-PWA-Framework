// T071: pairing codes and the pairing flow fail cleanly: typed errors, nothing half-open left behind.
import { describe, expect, it } from 'vitest';
import { MockRtc } from '@sync/testkit';
import { PairingError, PairingLedger, decodePairing, encodePairing, type PairingPayload } from '../src/pairingCode';
import { createWebRtcTransport } from '../src/index';

const payload = (over: Partial<PairingPayload> = {}): PairingPayload => ({
  ver: 1,
  kind: 'offer',
  sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' + 'a=candidate:1 1 udp 2113937151 192.168.1.20 54321 typ host\r\n'.repeat(3),
  nonce: 'abc123',
  expiresAt: 1_000_000,
  ...over,
});

describe('pairing codes', () => {
  it('round-trips a payload and stays small enough for a QR code', async () => {
    const code = await encodePairing(payload());
    expect(code.startsWith('SP1.')).toBe(true);
    expect(code.length).toBeLessThan(1500);
    expect(await decodePairing(code, 500_000)).toEqual(payload());
  });

  it('ignores surrounding whitespace from copy and paste', async () => {
    const code = await encodePairing(payload());
    expect(await decodePairing(`  ${code}\n`, 0)).toEqual(payload());
  });

  it('rejects text that is not a pairing code, truncated codes, and typos', async () => {
    const code = await encodePairing(payload());
    const typo = code.slice(0, 20) + (code[20] === 'A' ? 'B' : 'A') + code.slice(21);
    for (const bad of ['', 'hello', 'SP1.', 'SP1.!!!', code.slice(0, code.length - 8), typo, 'SP2.' + code.slice(4)]) {
      await expect(decodePairing(bad, 0), bad.slice(0, 12)).rejects.toMatchObject({ code: 'malformed' });
    }
  });

  it('rejects an expired code', async () => {
    const code = await encodePairing(payload({ expiresAt: 1000 }));
    await expect(decodePairing(code, 1001)).rejects.toMatchObject({ code: 'expired' });
    expect((await decodePairing(code, 1000)).nonce).toBe('abc123');
  });

  it('a ledger lets each code be used once', () => {
    const l = new PairingLedger();
    l.consume('a');
    expect(() => l.consume('a')).toThrow(PairingError);
    expect(() => l.consume('b')).not.toThrow();
  });
});

function pair(opts: { ttl?: number; connectTimeoutMs?: number } = {}) {
  const rtc = new MockRtc();
  const now = { t: 1_000 };
  const mk = (id: string) =>
    createWebRtcTransport({ id, RTCPeerConnection: rtc.RTCPeerConnection, now: () => now.t, codeTtlMs: opts.ttl, connectTimeoutMs: opts.connectTimeoutMs ?? 200 });
  return { rtc, now, a: mk('webrtc'), b: mk('webrtc') };
}

describe('pairing flow', () => {
  it('connects two transports through offer, answer and accept', async () => {
    const { a, b } = pair();
    await a.start();
    await b.start();
    expect(a.state).toBe('needs-pairing');
    const peers: string[] = [];
    a.on('peerConnected', (p) => peers.push(p.id));
    b.on('peerConnected', (p) => peers.push(p.id));
    const offer = await a.createOffer();
    const answer = await b.acceptOffer(offer.code);
    await a.acceptAnswer(offer.sessionId, answer.code);
    expect(peers).toHaveLength(2);
    expect(a.state).toBe('ready');
    expect(b.state).toBe('ready');
  });

  it('refuses a malformed code and leaves nothing open', async () => {
    const { a, rtc } = pair();
    await a.start();
    await expect(a.acceptOffer('garbage')).rejects.toMatchObject({ code: 'malformed' });
    expect(rtc.pcs.filter((p) => !p.closed)).toHaveLength(0);
  });

  it('refuses an expired offer and closes the connection it created', async () => {
    const { a, b, now, rtc } = pair({ ttl: 10_000 });
    await a.start();
    await b.start();
    const offer = await a.createOffer();
    now.t += 20_000;
    await expect(b.acceptOffer(offer.code)).rejects.toMatchObject({ code: 'expired' });
    // the offering side's own connection is released once its offer expires
    a.cancelPairing(offer.sessionId);
    expect(rtc.pcs.every((p) => p.closed)).toBe(true);
  });

  it('refuses to use an offer code twice', async () => {
    const { a, b } = pair();
    await a.start();
    await b.start();
    const offer = await a.createOffer();
    await b.acceptOffer(offer.code);
    await expect(b.acceptOffer(offer.code)).rejects.toMatchObject({ code: 'reused' });
  });

  it('refuses an answer for a session it does not know, or one that belongs to another offer', async () => {
    const { a, b } = pair();
    await a.start();
    await b.start();
    const o1 = await a.createOffer();
    const o2 = await a.createOffer();
    const answer1 = await b.acceptOffer(o1.code);
    await expect(a.acceptAnswer('no-such-session', answer1.code)).rejects.toMatchObject({ code: 'mismatch' });
    await expect(a.acceptAnswer(o2.sessionId, answer1.code)).rejects.toMatchObject({ code: 'mismatch' });
    await a.acceptAnswer(o1.sessionId, answer1.code); // the right pairing still works
    await expect(a.acceptAnswer(o1.sessionId, answer1.code)).rejects.toMatchObject({ code: 'reused' });
  });

  it('refuses an offer code where an answer is expected, and vice versa', async () => {
    const { a, b } = pair();
    await a.start();
    await b.start();
    const offer = await a.createOffer();
    await expect(a.acceptAnswer(offer.sessionId, offer.code)).rejects.toMatchObject({ code: 'malformed' });
    const answer = await b.acceptOffer(offer.code);
    await expect(b.acceptOffer(answer.code)).rejects.toMatchObject({ code: 'malformed' });
  });

  it('times out when the channel never opens, reports it, and cleans up', async () => {
    const { a, b, rtc } = pair({ connectTimeoutMs: 80 });
    await a.start();
    await b.start();
    const errors: string[] = [];
    a.on('error', (e) => errors.push(e.code));
    const offer = await a.createOffer();
    const answer = await b.acceptOffer(offer.code);
    rtc.dropOpen = true; // the network between them is blocked
    await expect(a.acceptAnswer(offer.sessionId, answer.code)).rejects.toMatchObject({ code: 'timeout' });
    expect(errors).toContain('unreachable');
    expect(rtc.pcs.every((p) => p.closed)).toBe(true);
    expect(a.state).toBe('needs-pairing');
  });

  it('reports "unreachable" and releases the connection when the data channel never opens', async () => {
    const { b, a, rtc } = pair({ connectTimeoutMs: 60 });
    await a.start();
    await b.start();
    const errors: string[] = [];
    b.on('error', (e) => errors.push(e.code));
    const offer = await a.createOffer();
    await b.acceptOffer(offer.code); // b answers, but the answer is never delivered to a
    rtc.dropOpen = true;
    await new Promise((r) => setTimeout(r, 150));
    expect(errors).toContain('unreachable');
    expect(rtc.pcs[1]!.closed).toBe(true); // b released the connection it opened for the answer
    expect(rtc.pcs[0]!.closed).toBe(false); // a's offer is still waiting for its answer
    expect(b.state).toBe('needs-pairing');
  });
});
