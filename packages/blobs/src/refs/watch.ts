/**
 * Watches applied packets for blob references (research R-09). The reference index (US3) builds on this; on its own
 * it implements the optional `prefetch` rule: a reference that matches is requested without anyone asking.
 */

import type { Engine } from '../engine';
import { extractRefs, validateRef, type BlobRef } from '../format/ref';

/** Every valid, current-version reference in an object's fields. */
export function refsIn(fields: Record<string, unknown>, maxBlobBytes: number): BlobRef[] {
  const out: BlobRef[] = [];
  for (const value of Object.values(fields)) {
    for (const candidate of extractRefs(value)) {
      const v = validateRef(candidate, { maxBlobBytes });
      if (v.ok) out.push(v.ref);
    }
  }
  return out;
}

export function watchApplied(e: Engine, onRefs: (refs: BlobRef[], objectId: string) => void): () => void {
  return e.core.onApplied(({ object }) => {
    if (!object || e.closed) return;
    const refs = refsIn(object.fields, e.cfg.maxBlobBytes);
    if (refs.length) onRefs(refs, object.id);
  });
}

/** Request, in the background, every reference the app's `prefetch` rule accepts and that is not on this device yet. */
export function startPrefetch(e: Engine): () => void {
  const rule = e.cfg.prefetch;
  if (!rule) return () => undefined;
  const asked = new Set<string>();
  return watchApplied(e, (refs) => {
    for (const ref of refs) {
      if (asked.has(ref.id)) continue;
      let wanted = false;
      try {
        wanted = rule(ref);
      } catch {
        // a faulty rule never breaks the engine
      }
      if (!wanted) continue;
      asked.add(ref.id);
      void e.scheduler.request(ref, { priority: 'low' }).catch(() => asked.delete(ref.id));
    }
  });
}
