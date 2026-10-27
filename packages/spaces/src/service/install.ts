import { createSyncCore, type Config, type SyncCore } from '@sync/core';
import { detectSupport } from '../crypto/support';
import { indexedDbKeyDb, memoryKeyDb, type KeyDb } from '../keystore/keydb';
import { Keystore } from '../keystore/keystore';
import { UnsupportedError, type InstallOptions, type Spaces, type SpacesOptions } from './api';
import { SpacesService } from './spaces';

/** The API of a Spaces layer that cannot run here: every call fails with a clear error. No plaintext fallback. */
function unsupported(reason: string): Spaces {
  const fail = (): never => {
    throw new UnsupportedError(reason);
  };
  return {
    state: 'unsupported',
    blobKeys: {
      scopeFor: () => fail(),
      forWrite: async () => fail(),
      forRead: async () => fail(),
      onKeysChanged: () => () => undefined,
    },
    session: () => undefined,
    signUp: async () => fail(),
    create: async () => fail(),
    list: async () => [],
    members: async () => fail(),
    setRole: async () => fail(),
    remove: async () => fail(),
    leave: async () => fail(),
    invite: async () => fail(),
    revokeInvite: async () => fail(),
    accept: async () => fail(),
    linkDevice: async () => fail(),
    joinAsDevice: async () => fail(),
    revokeDevice: async () => fail(),
    share: async () => fail(),
    createInShare: async () => fail(),
    shareOf: async () => fail(),
    setShareRole: async () => fail(),
    rejectedCount: async () => 0,
    on: () => () => undefined,
    idle: async () => undefined,
    close: async () => undefined,
  };
}

async function openKeyDb(k: SpacesOptions['keyDb']): Promise<KeyDb> {
  if (k && typeof k === 'object') return k;
  return indexedDbKeyDb({ name: typeof k === 'string' ? k : undefined });
}

/**
 * Plug Spaces into an existing core: registers the encrypting codec, the signer, the validators and the
 * snapshot guard. The core's device ID must be the keystore device's ID, so prefer `openSecureCore`.
 */
export async function installSpaces(opts: InstallOptions & { keystore: Keystore }): Promise<Spaces> {
  const support = await detectSupport();
  if (!support.ok) return unsupported(support.reason);
  if (opts.core.deviceId !== opts.keystore.device()?.deviceId)
    throw new Error('the core must use the keystore device ID (use openSecureCore)');
  const svc = new SpacesService({ ...opts });
  await svc.start();
  return svc;
}

export interface SecureCoreOptions extends SpacesOptions {
  /** Core settings. `deviceId` and `codecs` are set for you; the plaintext codec is never registered. */
  core: Omit<Config, 'deviceId' | 'codecs'>;
}

/**
 * Open a core whose every packet is end-to-end encrypted and signed (Principle V). The device keys are created
 * on first run, and the core uses the device ID derived from the signing key (research R-02).
 */
export async function openSecureCore(opts: SecureCoreOptions): Promise<{ core: SyncCore; spaces: Spaces }> {
  const support = await detectSupport();
  if (!support.ok) {
    // a core with no codec cannot write anything: it stays usable for reading nothing, and never in plaintext
    const core = await createSyncCore({ ...opts.core, codecs: [] });
    return { core, spaces: unsupported(support.reason) };
  }
  const keystore = await Keystore.open(await openKeyDb(opts.keyDb), opts.now);
  if (!keystore.device()) await keystore.createDevice();
  const core = await createSyncCore({ ...opts.core, deviceId: keystore.device()!.deviceId, codecs: [] });
  const spaces = await installSpaces({ ...opts, core, keystore });
  return { core, spaces };
}

export { memoryKeyDb };

/**
 * Release gate (Principle V): throws unless the core writes only with the encrypting codec. Call it at app start
 * in release builds, or let `openSecureCore` do the wiring so there is nothing to check.
 */
export function assertSecureCore(core: SyncCore): void {
  const { default: d, ids } = core.codecs();
  if (d !== 'aes-gcm-space/1' || ids.some((i) => i !== 'aes-gcm-space/1')) {
    throw new Error(
      `insecure core: payload codecs are ${JSON.stringify(ids)} with default ${String(d)}; release builds must use only aes-gcm-space/1`,
    );
  }
}
