/** Runs features: non-visual logic that reacts to object changes (FR-008, research R-12). */

import type { Query } from '@sync/core';
import type { FeatureDef, HostEvent, ModuleContext, ProjectedObject } from '../types';

/** The part of the Web Locks API the runner uses. */
export interface LocksLike {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

export interface FeatureHandle {
  readonly state: 'waiting' | 'running' | 'stopped';
  stop(): Promise<void>;
}

export interface RunnerOptions {
  emit(e: HostEvent): void;
  /** null: Web Locks unavailable. */
  locks: LocksLike | null;
  /** Consecutive handler failures before the feature is stopped. Default 5. */
  maxFailures?: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class FeatureRunner {
  constructor(private readonly o: RunnerOptions) {}

  /** Never throws: a feature that cannot start is reported and stopped. */
  async start(moduleId: string, def: FeatureDef, ctx: ModuleContext): Promise<FeatureHandle> {
    const run = new Run(moduleId, def, ctx, this.o);
    await run.launch();
    return run;
  }
}

class Run implements FeatureHandle {
  state: 'waiting' | 'running' | 'stopped' = 'waiting';
  private readonly subs: Array<() => void> = [];
  private cleanup?: () => void;
  private failures = 0;
  private release?: () => void;
  private torn = false;

  constructor(
    private readonly moduleId: string,
    private readonly def: FeatureDef,
    private readonly ctx: ModuleContext,
    private readonly o: RunnerOptions,
  ) {}

  async launch(): Promise<void> {
    const singleton = this.def.singleton !== false;
    if (singleton && this.o.locks) {
      const held = new Promise<void>((res) => (this.release = res));
      void this.o
        .locks.request(`sync-feature:${this.moduleId}.${this.def.id}`, async () => {
          if (this.torn) return;
          await this.begin();
          await held;
        })
        .catch(() => undefined);
      return;
    }
    if (singleton) this.ctx.log.warn(`Web Locks unavailable: feature "${this.moduleId}.${this.def.id}" runs in every open tab`);
    await this.begin();
  }

  private async begin(): Promise<void> {
    try {
      const result = await this.def.start(this.guardedCtx());
      if (typeof result === 'function') this.cleanup = result;
      if (!this.torn) this.state = 'running';
      else this.cleanup?.(); // stopped while starting: teardown already ran without this cleanup
    } catch (e) {
      await this.shutdown(e);
    }
  }

  /** The context the feature sees: its subscriptions are tracked and their handlers counted. */
  private guardedCtx(): ModuleContext {
    const base = this.ctx;
    const guard = (q: Query<ProjectedObject>): Query<ProjectedObject> => ({
      subscribe: (cb) => {
        const unsub = q.subscribe((rows) => {
          try {
            cb(rows);
            this.failures = 0;
          } catch (e) {
            void this.handlerFailed(e);
          }
        });
        this.subs.push(unsub);
        return unsub;
      },
      once: () => q.once(),
      [Symbol.asyncIterator]: () => q[Symbol.asyncIterator](),
    });
    return { ...base, data: { ...base.data, query: (spec) => guard(base.data.query(spec)) } };
  }

  private async handlerFailed(e: unknown): Promise<void> {
    if (++this.failures >= (this.o.maxFailures ?? 5)) await this.shutdown(e);
  }

  private async shutdown(e: unknown): Promise<void> {
    if (this.torn) return;
    this.o.emit({ kind: 'feature:stopped', module: this.moduleId, feature: this.def.id, error: message(e) });
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    if (this.torn) return;
    this.torn = true;
    this.state = 'stopped';
    for (const u of this.subs.splice(0)) u();
    for (const f of [this.cleanup, this.def.stop?.bind(this.def)]) {
      try {
        await f?.();
      } catch (e) {
        this.ctx.log.warn(`feature "${this.moduleId}.${this.def.id}" cleanup failed: ${message(e)}`);
      }
    }
    this.release?.();
  }

  async stop(): Promise<void> {
    await this.teardown();
  }
}
