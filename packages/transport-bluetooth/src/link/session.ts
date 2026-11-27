/** Encrypted link messages (kind 0xE0): `0xE0 | counter(8 B BE) | AES-256-GCM(inner)`; nonce = 4 zero bytes | counter; AAD = 0xE0 | counter. */

import { bs, concat, readU64be, u64be } from './bytes';

export const KIND_ENCRYPTED = 0xe0;
const MAX_COUNTER = 2 ** 53 - 1;

export class LinkSession {
  private sendCounter = 0;
  private recvCounter = 0;

  private constructor(
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
  ) {}

  /** `sendRaw` encrypts what we send, `recvRaw` decrypts what we receive (32 bytes each). */
  static async create(sendRaw: Uint8Array, recvRaw: Uint8Array): Promise<LinkSession> {
    const imp = (raw: Uint8Array) => crypto.subtle.importKey('raw', bs(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return new LinkSession(await imp(sendRaw), await imp(recvRaw));
  }

  /** `counter` is for known-answer tests; normally it increments on its own, starting at 1. */
  async seal(inner: Uint8Array, counter?: number): Promise<Uint8Array> {
    const c = counter ?? this.sendCounter + 1;
    if (c > MAX_COUNTER) throw new Error('link counter exhausted');
    this.sendCounter = c;
    const ctr = u64be(c);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: bs(concat(new Uint8Array(4), ctr)), additionalData: bs(concat(Uint8Array.of(KIND_ENCRYPTED), ctr)), tagLength: 128 },
        this.sendKey,
        bs(inner),
      ),
    );
    return concat(Uint8Array.of(KIND_ENCRYPTED), ctr, ct);
  }

  /** Null for anything that is not a fresh, authentic message: wrong kind, replay, old counter, tampering. */
  async open(msg: Uint8Array): Promise<Uint8Array | null> {
    if (msg.length < 1 + 8 + 16 || msg[0] !== KIND_ENCRYPTED) return null;
    const ctrBytes = msg.slice(1, 9);
    const c = readU64be(msg, 1);
    if (c <= this.recvCounter || c > MAX_COUNTER) return null;
    try {
      const pt = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bs(concat(new Uint8Array(4), ctrBytes)), additionalData: bs(concat(Uint8Array.of(KIND_ENCRYPTED), ctrBytes)), tagLength: 128 },
          this.recvKey,
          bs(msg.slice(9)),
        ),
      );
      this.recvCounter = c; // only a message that authenticates advances the replay window
      return pt;
    } catch {
      return null;
    }
  }
}
