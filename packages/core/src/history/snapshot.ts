/** Snapshots: compacted state of a Space (specs/001-sync-core/data-model.md). */

import { mergeIntervals } from '../sync/intervals';
import { joinObjects, type StoredObject } from '../store/objects';
import type { Held } from '../store/summaries';

export interface Snapshot {
  space: string;
  /** Which packets (author, seq ranges) have been folded into `objects`. */
  covers: Held;
  /** State as produced by the folded packets only. */
  objects: StoredObject[];
  createdAt: number;
}

/** Union of two snapshots of the same Space: join the objects, union the coverage. Idempotent. */
export function mergeSnapshots(a: Snapshot | undefined, b: Snapshot): Snapshot {
  if (!a) return structuredClone(b);
  const objects = new Map<string, StoredObject>(a.objects.map((o) => [o.id, o]));
  for (const o of b.objects) objects.set(o.id, joinObjects(objects.get(o.id), o));
  const covers: Held = structuredClone(a.covers);
  for (const [author, iv] of Object.entries(b.covers)) covers[author] = mergeIntervals(covers[author] ?? [], iv);
  return {
    space: a.space,
    covers,
    objects: [...objects.values()].sort((x, y) => (x.id < y.id ? -1 : 1)),
    createdAt: Math.max(a.createdAt, b.createdAt),
  };
}
