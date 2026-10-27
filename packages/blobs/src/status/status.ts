/**
 * Per-blob status (FR-010): one shared state per blob ID, observed by any number of views. It is derived, never
 * authoritative: the stored record and the active transfer are the sources of truth.
 */

import type { BlobRef } from '../format/ref';
import type { BlobStatus, BlobStorage, Observable, StoredBlob } from '../types';

interface Entry {
  status: BlobStatus;
  listeners: Set<(s: BlobStatus) => void>;
  loaded: boolean;
}

const same = (a: BlobStatus, b: BlobStatus) =>
  a.state === b.state && a.reason === b.reason && a.progress === b.progress && a.bytesDone === b.bytesDone && a.pinned === b.pinned && a.replicas === b.replicas && a.size === b.size;

export class StatusHub {
  private entries = new Map<string, Entry>();

  constructor(private readonly storage: () => BlobStorage) {}

  private entry(id: string, size: number): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = {
        status: { state: 'missing', reason: 'not-requested', size, progress: 0, bytesDone: 0, pinned: false, replicas: 0 },
        listeners: new Set(),
        loaded: false,
      };
      this.entries.set(id, e);
    }
    return e;
  }

  get(id: string, size = 0): BlobStatus {
    return this.entry(id, size).status;
  }

  /** Merge a change and tell observers when something actually changed. */
  update(id: string, patch: Partial<BlobStatus>, size = 0): void {
    const e = this.entry(id, size);
    const next: BlobStatus = { ...e.status, ...patch };
    if (next.state === 'available') {
      next.progress = 1;
      next.bytesDone = next.size;
      delete next.reason;
    }
    if (patch.state !== undefined && patch.reason === undefined && next.state !== 'failed' && next.state !== 'missing') delete next.reason;
    if (same(e.status, next)) return;
    e.status = next;
    for (const l of [...e.listeners]) {
      try {
        l(next);
      } catch {
        // a faulty observer must never break the engine
      }
    }
  }

  /** Reflect a stored record that is (or is not) complete on this device. */
  fromRecord(rec: StoredBlob, activeDownload = false): void {
    const e = this.entry(rec.id, rec.size);
    e.loaded = true;
    const base = { size: rec.size, pinned: rec.pinned, replicas: rec.replicas.length };
    if (rec.complete) this.update(rec.id, { ...base, state: 'available' });
    else if (!activeDownload) this.update(rec.id, { ...base, state: 'missing', reason: 'evicted', progress: 0, bytesDone: 0 });
  }

  observe(ref: BlobRef): Observable<BlobStatus> {
    const e = this.entry(ref.id, ref.size);
    if (!e.loaded) {
      e.loaded = true;
      void this.storage()
        .getBlob(ref.id)
        .then((rec) => rec && this.fromRecord(rec, e.status.state === 'downloading'))
        .catch(() => undefined);
    }
    return {
      get: () => e.status,
      subscribe: (l) => {
        e.listeners.add(l);
        return () => void e.listeners.delete(l);
      },
    };
  }
}
