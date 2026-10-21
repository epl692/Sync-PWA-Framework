export class Emitter<E> {
  private handlers = new Set<(e: E) => void>();

  on(cb: (e: E) => void): () => void {
    this.handlers.add(cb);
    return () => void this.handlers.delete(cb);
  }

  emit(e: E): void {
    for (const h of [...this.handlers]) {
      try {
        h(e);
      } catch {
        // a faulty listener must never break the core
      }
    }
  }
}
