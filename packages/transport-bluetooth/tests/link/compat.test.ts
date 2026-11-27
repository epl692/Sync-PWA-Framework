// Spec 005 T101: forward and backward compatibility rules of link/1 (contracts/bluetooth-link.md#compatibility).
import { describe, expect, it } from 'vitest';
import { FrameType, LINK_VERSIONS, decodeFrame, decodeInner, encodeControl, encodeFrame, encodeInfo, parseInfo, type Frame } from '../../src/link';
import { acceptHello, startClientHandshake } from '../../src/link';

describe('link/1 compatibility', () => {
  it('unknown control types and unknown fields are ignored, not errors', () => {
    const msg = decodeInner(encodeControl({ t: 'future-thing', x: [1, 2, 3] } as never));
    expect(msg).toMatchObject({ kind: 'control', msg: { t: 'future-thing' } });
    const withExtra = decodeInner(encodeControl({ t: 'ping', later: 'field' } as never));
    expect(withExtra).toMatchObject({ kind: 'control', msg: { t: 'ping', later: 'field' } });
  });

  it('reserved frame bits are sent as 0 and ignored when set by a newer peer', () => {
    const f: Frame = { type: FrameType.DATA, stream: 0, start: true, end: true, seq: 3, payload: Uint8Array.of(1) };
    expect(encodeFrame(f)[0]! & 0b111).toBe(0);
    const raw = encodeFrame(f);
    raw[0] |= 0b101;
    expect(decodeFrame(raw)).toEqual(f);
    expect(decodeFrame(Uint8Array.of(0b11_000000, 0))).toBeNull(); // the reserved frame type is dropped, never misread
  });

  it('INFO: an unknown extra field is ignored, a bad shape is refused, and the version range is read', () => {
    const base = { v: [1, 4], name: 'Hub', fp: 'aaaa', mode: 'open', slots: 2, full: false, maxWrite: 244 };
    const withExtra = new TextEncoder().encode(JSON.stringify({ ...base, future: true }));
    expect(parseInfo(withExtra)).toMatchObject({ v: [1, 4], name: 'Hub', slots: 2 });
    expect(parseInfo(new TextEncoder().encode('{"v":"1"}'))).toBeNull();
    expect(parseInfo(new TextEncoder().encode('not json'))).toBeNull();
    expect(parseInfo(new Uint8Array(600))).toBeNull(); // over 512 bytes
    expect(parseInfo(encodeInfo({ v: LINK_VERSIONS, name: 'x', fp: 'y', mode: 'approval', slots: 0, full: true, maxWrite: 20 }))!.full).toBe(true);
  });

  it('overlapping version ranges negotiate down to the highest common version; non-overlapping ones fail', async () => {
    const hub = { publicKey: new Uint8Array(32).fill(1), sign: async () => new Uint8Array(64) };
    const c = await startClientHandshake([1, 3]);
    const ok = await acceptHello(c.hello, hub, [2, 5]);
    expect(ok.version).toBe(3);
    const c2 = await startClientHandshake([4, 6]);
    await expect(acceptHello(c2.hello, hub, [1, 3])).rejects.toMatchObject({ code: 'version-mismatch' });
  });

  it('a newer peer\'s extra fields in hello are tolerated', async () => {
    const hub = { publicKey: new Uint8Array(32).fill(1), sign: async () => new Uint8Array(64) };
    const c = await startClientHandshake([1, 1]);
    const o = JSON.parse(new TextDecoder().decode(c.hello.slice(1)));
    o.futureOption = { a: 1 };
    const tweaked = new Uint8Array([c.hello[0]!, ...new TextEncoder().encode(JSON.stringify(o))]);
    await expect(acceptHello(tweaked, hub, [1, 1])).resolves.toMatchObject({ version: 1 });
  });
});
