/** Static rules for a module definition (research R-02). Returns problems; empty means valid. */

import { NAME_RE } from '../schema/types';
import type { ModuleDefinition } from '../types';
import { parseVersion, validateRange } from './semver';

export const MODULE_ID_RE = /^[a-z][a-z0-9]{1,23}$/;
/** The local part of a custom element name: lowercase words joined by single hyphens. */
export const ELEMENT_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const FULL_TYPE_RE = /^[a-z][a-z0-9]{1,23}\.[a-z][A-Za-z0-9_]{0,31}$/;
const q = (s: unknown) => JSON.stringify(s);

export function validateDefinition(def: ModuleDefinition): string[] {
  const problems: string[] = [];
  const who = `module ${q(def.id)}`;
  const add = (msg: string) => problems.push(`${who}: ${msg}`);

  if (typeof def.id !== 'string' || !MODULE_ID_RE.test(def.id)) add(`id ${q(def.id)} must match ${MODULE_ID_RE}`);
  try {
    parseVersion(def.version);
  } catch {
    add(`version ${q(def.version)} must be semver x.y.z`);
  }

  for (const [dep, range] of Object.entries(def.dependencies ?? {})) {
    if (!MODULE_ID_RE.test(dep)) add(`dependency id ${q(dep)} must match ${MODULE_ID_RE}`);
    if (dep === def.id) add(`cannot depend on itself (${q(dep)})`);
    try {
      validateRange(range);
    } catch {
      add(`dependency ${q(dep)} has invalid range ${q(range)}`);
    }
  }

  const p = def.provides ?? {};
  const seenTypes = new Set<string>();
  for (const t of p.types ?? []) {
    if (typeof t.name !== 'string' || !NAME_RE.test(t.name)) add(`type name ${q(t.name)} must match ${NAME_RE}`);
    else if (seenTypes.has(t.name)) add(`duplicate type ${q(`${def.id}.${t.name}`)}`);
    seenTypes.add(t.name);
  }
  for (const name of Object.keys(p.views ?? {})) {
    if (!ELEMENT_NAME_RE.test(name)) add(`view name ${q(name)} must make a valid custom element name (${ELEMENT_NAME_RE})`);
  }
  const unique = (kind: string, ids: readonly string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== 'string' || !NAME_RE.test(id)) add(`${kind} id ${q(id)} must match ${NAME_RE}`);
      else if (seen.has(id)) add(`duplicate ${kind} ${q(`${def.id}.${id}`)}`);
      seen.add(id);
    }
  };
  unique('feature', (p.features ?? []).map((f) => f.id));
  unique('transport', (p.transports ?? []).map((f) => f.id));
  unique('identity provider', (p.identityProviders ?? []).map((f) => f.id));

  for (const [mode, list] of [['read', def.access?.types?.read], ['write', def.access?.types?.write]] as const) {
    for (const name of list ?? []) {
      if (typeof name !== 'string' || !FULL_TYPE_RE.test(name)) add(`access.types.${mode} entry ${q(name)} must be a full type name like "module.name"`);
    }
  }

  const sp = def.access?.spaces;
  for (const k of ['read', 'write'] as const) {
    const v = sp?.[k];
    if (v !== undefined && v !== 'any' && v !== 'bound') add(`access.spaces.${k} ${q(v)} must be "any" or "bound"`);
  }
  const read = sp?.read ?? 'bound';
  if (sp?.write === 'any' && read !== 'any') add(`access.spaces.write "any" requires access.spaces.read "any"`);

  return problems;
}
