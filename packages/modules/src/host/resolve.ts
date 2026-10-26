/** Turns module definitions into an activation order, deciding per module whether it can run (research R-05, R-06). */

import { validateDefinition } from '../definition/rules';
import { satisfies } from '../definition/semver';
import type { ModuleDefinition } from '../types';

export interface ResolveEntry {
  def: ModuleDefinition;
  source: 'bundled' | 'runtime';
}

/** A module that is already active (or already failed) when a later entry is resolved. */
export interface Known {
  version: string;
  ok: boolean;
  reason?: string;
}

export type ResolveStatus = 'resolved' | 'failed' | 'skipped';

export interface ResolveResult {
  /** One per input entry, in input order. */
  results: Array<{ entry: ResolveEntry; status: ResolveStatus; reason?: string }>;
  /** Only the resolved entries, dependencies first; ties broken by module id. */
  order: ResolveEntry[];
}

export function resolveModules(entries: readonly ResolveEntry[], known: ReadonlyMap<string, Known> = new Map()): ResolveResult {
  const results = entries.map((entry) => ({ entry, status: 'resolved' as ResolveStatus, reason: undefined as string | undefined }));
  const fail = (i: number, status: ResolveStatus, reason: string) => {
    results[i]!.status = status;
    results[i]!.reason = reason;
  };

  // 1. each definition on its own, then duplicate ids (first one wins)
  const winner = new Map<string, number>();
  results.forEach((r, i) => {
    const { def, source } = r.entry;
    const problems = validateDefinition(def);
    if (problems.length) return fail(i, 'failed', problems.join('; '));
    const prior = winner.get(def.id);
    if (prior !== undefined) {
      const w = results[prior]!.entry;
      return fail(i, 'failed', `duplicate module id "${def.id}": already declared by ${w.def.version} (${w.source}); this entry is ${def.version} (${source})`);
    }
    if (known.has(def.id)) return fail(i, 'failed', `duplicate module id "${def.id}": already registered as ${known.get(def.id)!.version}`);
    winner.set(def.id, i);
  });

  const viable = () => [...winner.values()].filter((i) => results[i]!.status === 'resolved');

  // 2. dependency checks until nothing changes; cycles are found when the rest cannot be ordered
  let order: number[] = [];
  for (;;) {
    let changed = false;
    for (const i of viable()) {
      const def = results[i]!.entry.def;
      for (const [dep, range] of Object.entries(def.dependencies ?? {})) {
        const j = winner.get(dep);
        const k = known.get(dep);
        if (j === undefined && !k) {
          fail(i, 'skipped', `missing dependency "${dep}"`);
        } else if (j !== undefined) {
          const dr = results[j]!;
          if (dr.status !== 'resolved') {
            fail(i, 'skipped', `dependency "${dep}" ${dr.status === 'failed' ? 'failed' : 'was skipped'}: ${dr.reason}`);
          } else if (!satisfies(dr.entry.def.version, range)) {
            fail(i, 'failed', `unsatisfied-dependency: "${def.id}" needs "${dep}" ${range} but ${dr.entry.def.version} is the only version available`);
          }
        } else if (k) {
          if (!k.ok) fail(i, 'skipped', `dependency "${dep}" is not available: ${k.reason ?? 'failed'}`);
          else if (!satisfies(k.version, range)) fail(i, 'failed', `unsatisfied-dependency: "${def.id}" needs "${dep}" ${range} but ${k.version} is the only version available`);
        }
        if (results[i]!.status !== 'resolved') {
          changed = true;
          break;
        }
      }
    }
    if (changed) continue;

    // order what is left (Kahn, ties by id)
    const ids = viable();
    const byId = new Map(ids.map((i) => [results[i]!.entry.def.id, i]));
    const remaining = new Map(ids.map((i) => [i, Object.keys(results[i]!.entry.def.dependencies ?? {}).filter((d) => byId.has(d)).length]));
    order = [];
    const ready = () => [...remaining.entries()].filter(([, n]) => n === 0).map(([i]) => i).sort((a, b) => (results[a]!.entry.def.id < results[b]!.entry.def.id ? -1 : 1));
    for (let r = ready(); r.length; r = ready()) {
      const next = r[0]!;
      remaining.delete(next);
      order.push(next);
      const nextId = results[next]!.entry.def.id;
      for (const [i, n] of remaining) if (nextId in (results[i]!.entry.def.dependencies ?? {})) remaining.set(i, n - 1);
    }
    if (!remaining.size) break;

    // what remains is in a cycle or depends on one: fail the members of cycles, the rest become skipped next round
    const left = [...remaining.keys()];
    const depsOf = (i: number) => Object.keys(results[i]!.entry.def.dependencies ?? {}).map((d) => byId.get(d)).filter((j): j is number => j !== undefined && remaining.has(j));
    const inCycle = (start: number): number[] | undefined => {
      const path: number[] = [];
      const seen = new Set<number>();
      const dfs = (n: number): boolean => {
        if (n === start && path.length) return true;
        if (seen.has(n)) return false;
        seen.add(n);
        path.push(n);
        for (const m of depsOf(n)) if (dfs(m)) return true;
        path.pop();
        return false;
      };
      return dfs(start) ? [...path, start] : undefined;
    };
    for (const i of left) {
      const cyc = inCycle(i);
      if (cyc) fail(i, 'failed', `dependency cycle: ${cyc.map((n) => results[n]!.entry.def.id).join(' -> ')}`);
    }
  }

  return { results, order: order.map((i) => results[i]!.entry) };
}
