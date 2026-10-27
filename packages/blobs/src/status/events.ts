/** A small typed event emitter. A faulty listener never breaks the engine. */

import type { BlobEvents } from '../types';

export class BlobEmitter {
  private handlers = new Map<keyof BlobEvents, Set<(e: never) => void>>();

  on<K extends keyof BlobEvents>(event: K, handler: (e: BlobEvents[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as (e: never) => void);
    return () => void set!.delete(handler as (e: never) => void);
  }

  emit<K extends keyof BlobEvents>(event: K, payload: BlobEvents[K]): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) {
      try {
        (h as (e: BlobEvents[K]) => void)(payload);
      } catch {
        // a faulty listener must never break the engine
      }
    }
  }
}
