/** Module reports and host events: the observable state for developers (data-model.md). */

import { normalizeAccess } from '../definition/access';
import type { HostEvent, ModuleReport, ModuleStatus } from '../types';
import type { ResolveEntry } from './resolve';

export function newReport(entry: ResolveEntry, status: ModuleStatus, reason?: string): ModuleReport {
  const { def } = entry;
  const p = def.provides ?? {};
  const report: ModuleReport = {
    id: def.id,
    version: def.version,
    source: entry.source,
    status,
    dependencies: { ...(def.dependencies ?? {}) },
    access: safeAccess(entry),
    registers: {
      types: (p.types ?? []).map((t) => `${def.id}.${t.name}`),
      views: Object.keys(p.views ?? {}).map((v) => `${def.id}-${v}`),
      features: (p.features ?? []).map((f) => `${def.id}.${f.id}`),
      transports: (p.transports ?? []).map((t) => `${def.id}.${t.id}`),
      identityProviders: (p.identityProviders ?? []).map((t) => `${def.id}.${t.id}`),
    },
  };
  if (reason !== undefined) report.reason = reason;
  return report;
}

/** An invalid definition must still be reportable. */
function safeAccess(entry: ResolveEntry) {
  try {
    return normalizeAccess(entry.def);
  } catch {
    return { types: { read: [], write: [] }, spaces: { read: 'bound' as const, write: 'bound' as const, manage: false } };
  }
}

export class HostState {
  private readonly listeners = new Set<(e: HostEvent) => void>();
  private readonly reports = new Map<string, ModuleReport>();

  on(cb: (e: HostEvent) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  emit = (e: HostEvent): void => {
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch {
        /* a broken listener never affects the host */
      }
    }
  };

  /** Reports are keyed by id; a duplicate id's later entry is stored under `id#n` so it stays visible. */
  upsert(key: string, report: ModuleReport): void {
    this.reports.set(key, report);
  }

  patch(key: string, patch: Partial<ModuleReport>): void {
    const r = this.reports.get(key);
    if (r) this.reports.set(key, { ...r, ...patch });
  }

  get(key: string): ModuleReport | undefined {
    return this.reports.get(key);
  }

  list(): ModuleReport[] {
    return [...this.reports.values()];
  }
}
