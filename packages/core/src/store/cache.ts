import type { StorageAdapter } from '../storage/types';
import type { StoredObject } from './objects';

/** Write-through in-memory copy of the `objects` store with a per-type index. */
export class ObjectCache {
  private byId = new Map<string, StoredObject>();
  private byType = new Map<string, Set<string>>();

  async load(storage: StorageAdapter): Promise<void> {
    await storage.transaction(['objects'], 'readonly', async (tx) => {
      for await (const { value } of tx.scan<StoredObject>('objects')) this.set(value);
    });
  }

  get(id: string): StoredObject | undefined {
    return this.byId.get(id);
  }

  set(obj: StoredObject): void {
    const prev = this.byId.get(obj.id);
    if (prev && prev.type !== obj.type) this.byType.get(prev.type)?.delete(obj.id);
    this.byId.set(obj.id, obj);
    let set = this.byType.get(obj.type);
    if (!set) this.byType.set(obj.type, (set = new Set()));
    set.add(obj.id);
  }

  *ofType(type: string): IterableIterator<StoredObject> {
    const ids = this.byType.get(type);
    if (!ids) return;
    for (const id of ids) {
      const o = this.byId.get(id);
      if (o) yield o;
    }
  }

  all(): IterableIterator<StoredObject> {
    return this.byId.values();
  }

  get size(): number {
    return this.byId.size;
  }
}
