import { describe, expect, it } from 'vitest';
import { b64urlEncode, canonicalBytes } from '../../src/packet/canonical';
import { EnvelopeError, buildEnvelope, decodeEnvelope, encodeEnvelope } from '../../src/packet/envelope';
import { formatClock } from '../../src/clock/hlc';

const AUTHOR = 'KAAAAAAAAAAAAAAAAAAAAAAAAA';

function obj() {
  return {
    v: 1,
    id: `${AUTHOR}:42`,
    author: AUTHOR,
    seq: 42,
    space: 's1',
    clock: formatClock(1000, 1, AUTHOR),
    codec: 'c/1',
    body: b64urlEncode(new Uint8Array([1, 2, 3])),
    sig: null,
  };
}

const base = () =>
  buildEnvelope({
    author: AUTHOR,
    seq: 42,
    space: 's1',
    clock: formatClock(1000, 1, AUTHOR),
    codec: 'c/1',
    body: new Uint8Array([1, 2, 3]),
    sig: null,
  });

describe('envelope', () => {
  it('derives id as author:seq and round-trips', () => {
    const env = base();
    expect(env.id).toBe(`${AUTHOR}:42`);
    const raw = encodeEnvelope(env);
    const dec = decodeEnvelope(raw);
    expect(dec.env).toEqual(env);
    expect(dec.unsupportedVersion).toBe(false);
    expect(Array.from(dec.raw)).toEqual(Array.from(raw));
  });

  it('rejects an id that is not author:seq', () => {
    expect(() => decodeEnvelope(canonicalBytes({ ...obj(), id: 'other:42' }))).toThrow(EnvelopeError);
  });

  it('rejects a clock whose device suffix is not the author', () => {
    const raw = canonicalBytes({ ...obj(), clock: formatClock(1000, 1, 'SOMEONEELSE') });
    expect(() => decodeEnvelope(raw)).toThrow(EnvelopeError);
  });

  it('rejects bad seq, empty space, malformed JSON, and bad base64url', () => {
    for (const patch of [{ seq: 0 }, { seq: 1.5 }, { space: '' }, { body: 'a+b' }, { sig: 'a=' }]) {
      expect(() => decodeEnvelope(canonicalBytes({ ...obj(), ...patch })), JSON.stringify(patch)).toThrow(EnvelopeError);
    }
    expect(() => decodeEnvelope(new TextEncoder().encode('{nope'))).toThrow(EnvelopeError);
  });

  it('keeps the original bytes verbatim, including unknown extra fields', () => {
    const raw = canonicalBytes({ ...obj(), futureField: { x: 1 } });
    const dec = decodeEnvelope(raw);
    expect(dec.unsupportedVersion).toBe(false);
    expect(dec.raw).toBe(raw);
    expect(Object.keys(dec.env)).not.toContain('futureField');
  });

  it('flags a newer version but still yields id, author, seq, space', () => {
    const raw = canonicalBytes({ v: 2, id: `${AUTHOR}:7`, author: AUTHOR, seq: 7, space: 's1', whatever: 1 });
    const dec = decodeEnvelope(raw);
    expect(dec.unsupportedVersion).toBe(true);
    expect(dec.env).toMatchObject({ id: `${AUTHOR}:7`, author: AUTHOR, seq: 7, space: 's1' });
  });

  it('enforces maxBytes with a too-large error', () => {
    const raw = encodeEnvelope(base());
    expect(() => decodeEnvelope(raw, 10)).toThrowError(expect.objectContaining({ code: 'too-large' }));
  });
});
