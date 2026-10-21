/**
 * Device keys, epoch keys and counters (research R-03).
 *
 * - Device signing and agreement private keys are non-extractable CryptoKeys.
 * - Epoch keys are stored only wrapped by a per-device non-extractable AES key, so a copy of the
 *   database without that key yields nothing.
 */

import { concat, hex, randomBytes, unhex, utf8 } from '../crypto/bytes';
import { deviceIdFromSignPub, keyIdOf } from '../crypto/ids';
import { aesOpen, aesSeal, generateAesKey, generateAgreeKeyPair, generateSignKeyPair, importAesKey } from '../crypto/suite';
import { base32Decode } from '../crypto/bytes';
import type { KeyDb } from './keydb';

export interface DeviceRecord {
  deviceId: string;
  signPriv: CryptoKey;
  signPub: Uint8Array;
  agreePriv: CryptoKey;
  agreePub: Uint8Array;
  wrapKey: CryptoKey;
  userId?: string;
  displayName?: string;
  createdAt: number;
}

export type KeySource = 'self' | 'grant' | 'join';

interface EpochKeyRecord {
  scope: string;
  epoch: number;
  keyId: string;
  wrapped: Uint8Array;
  nonce: Uint8Array;
  source: KeySource;
  createdAt: number;
}

export interface InviteSecret {
  secret: Uint8Array;
  seenNonces: string[];
}

const COUNTER_FLUSH_EVERY = 256;

export class Keystore {
  private dev: DeviceRecord | undefined;
  private aesCache = new Map<string, CryptoKey>();
  private counters = new Map<string, number>();
  private unflushed = new Map<string, number>();

  private constructor(
    private readonly db: KeyDb,
    private readonly now: () => number,
  ) {}

  static async open(db: KeyDb, now: () => number = () => Date.now()): Promise<Keystore> {
    const ks = new Keystore(db, now);
    ks.dev = await db.get<DeviceRecord>('device', 'self');
    return ks;
  }

  device(): DeviceRecord | undefined {
    return this.dev;
  }

  requireDevice(): DeviceRecord {
    if (!this.dev) throw new Error('no device on this install yet; sign up first');
    return this.dev;
  }

  /** Generate this install's keys. userId is set by the caller (genesis device: its own device ID). */
  async createDevice(opts: { displayName?: string; userId?: 'self' | string } = {}): Promise<DeviceRecord> {
    if (this.dev) throw new Error('a device already exists on this install');
    const sign = await generateSignKeyPair();
    const agree = await generateAgreeKeyPair();
    const deviceId = await deviceIdFromSignPub(sign.publicRaw);
    const rec: DeviceRecord = {
      deviceId,
      signPriv: sign.privateKey,
      signPub: sign.publicRaw,
      agreePriv: agree.privateKey,
      agreePub: agree.publicRaw,
      wrapKey: await generateAesKey(false),
      userId: opts.userId === 'self' ? deviceId : opts.userId,
      displayName: opts.displayName,
      createdAt: this.now(),
    };
    await this.db.put('device', 'self', rec);
    this.dev = rec;
    return rec;
  }

  async setUser(userId: string, displayName?: string): Promise<void> {
    const d = this.requireDevice();
    const next = { ...d, userId, displayName: displayName ?? d.displayName };
    await this.db.put('device', 'self', next);
    this.dev = next;
  }

  // ---- epoch keys ----

  private aad(scope: string, keyId: string): Uint8Array {
    return concat(utf8.encode('sync-keystore/1'), base32Decode(scope), unhex(keyId));
  }

  /** Store a raw epoch key (wrapped at rest). Idempotent. Returns its key ID (hex). */
  async putEpochKey(scope: string, epoch: number, raw: Uint8Array, source: KeySource): Promise<string> {
    const d = this.requireDevice();
    const keyId = hex(await keyIdOf(raw));
    const id = `${scope}:${keyId}`;
    if (await this.db.get('epoch-keys', id)) return keyId;
    const nonce = randomBytes(12);
    const wrapped = await aesSeal(d.wrapKey, nonce, raw, this.aad(scope, keyId));
    const rec: EpochKeyRecord = { scope, epoch, keyId, wrapped, nonce, source, createdAt: this.now() };
    await this.db.put('epoch-keys', id, rec);
    return keyId;
  }

  async hasKey(scope: string, keyId: string): Promise<boolean> {
    return (await this.db.get('epoch-keys', `${scope}:${keyId}`)) !== undefined;
  }

  /** All keys held for a scope, oldest epoch first. */
  async epochs(scope: string): Promise<Array<{ epoch: number; keyId: string; source: KeySource }>> {
    const rows = await this.db.all<EpochKeyRecord>('epoch-keys');
    return rows
      .map((r) => r.value)
      .filter((r) => r.scope === scope)
      .map((r) => ({ epoch: r.epoch, keyId: r.keyId, source: r.source }))
      .sort((a, b) => a.epoch - b.epoch || (a.keyId < b.keyId ? -1 : 1));
  }

  /** The raw key, for wrapping into a grant. */
  async rawKey(scope: string, keyId: string): Promise<Uint8Array | undefined> {
    const rec = await this.db.get<EpochKeyRecord>('epoch-keys', `${scope}:${keyId}`);
    if (!rec) return undefined;
    return (await aesOpen(this.requireDevice().wrapKey, rec.nonce, rec.wrapped, this.aad(scope, keyId))) ?? undefined;
  }

  /** A non-extractable key for encrypt/decrypt, or undefined when this device does not hold it. */
  async aesKey(scope: string, keyId: string): Promise<CryptoKey | undefined> {
    const id = `${scope}:${keyId}`;
    const cached = this.aesCache.get(id);
    if (cached) return cached;
    const raw = await this.rawKey(scope, keyId);
    if (!raw) return undefined;
    const key = await importAesKey(raw, false);
    this.aesCache.set(id, key);
    return key;
  }

  // ---- nonce-safety counters ----

  /** Count one encryption under a key. Returns the new total. Persisted every 256 uses and on flush(). */
  async bumpCounter(scope: string, keyId: string): Promise<number> {
    const id = `${scope}:${keyId}`;
    let n = this.counters.get(id);
    if (n === undefined) n = (await this.db.get<number>('counters', id)) ?? 0;
    n++;
    this.counters.set(id, n);
    this.unflushed.set(id, n);
    if (this.unflushed.size && n % COUNTER_FLUSH_EVERY === 0) await this.flush();
    return n;
  }

  async counter(scope: string, keyId: string): Promise<number> {
    const id = `${scope}:${keyId}`;
    return this.counters.get(id) ?? (await this.db.get<number>('counters', id)) ?? 0;
  }

  async flush(): Promise<void> {
    for (const [id, n] of this.unflushed) await this.db.put('counters', id, n);
    this.unflushed.clear();
  }

  // ---- invites (only on the creating device) ----

  putInvite(inviteId: string, v: InviteSecret): Promise<void> {
    return this.db.put('invites-local', inviteId, v);
  }

  getInvite(inviteId: string): Promise<InviteSecret | undefined> {
    return this.db.get<InviteSecret>('invites-local', inviteId);
  }

  // ---- a small local key-value store for the Identity Provider (never synced) ----

  async getLocal(key: string): Promise<Uint8Array | undefined> {
    return (await this.db.get<{ value: Uint8Array }>('invites-local', `kv:${key}`))?.value;
  }

  putLocal(key: string, value: Uint8Array): Promise<void> {
    return this.db.put('invites-local', `kv:${key}`, { value });
  }

  // ---- Spaces this install belongs to (so a newly joined, still-empty Space keeps syncing after a restart) ----

  async addSpace(space: string): Promise<void> {
    if (!(await this.db.get('spaces', space))) await this.db.put('spaces', space, { joinedAt: this.now() });
  }

  async spaces(): Promise<string[]> {
    return (await this.db.all('spaces')).map((r) => r.key).sort();
  }

  async close(): Promise<void> {
    await this.flush();
    await this.db.close();
  }
}
