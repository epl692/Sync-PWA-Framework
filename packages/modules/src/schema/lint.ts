/** checkSchema (schema-rules.md §2). The check that a `down` emits only declared names lives with US6 (T104). */

import { validateFieldValue } from './fields';
import { NAME_RE, type FieldDef, type ObjectTypeDef } from './types';

const q = (s: unknown) => JSON.stringify(s);

function checkField(name: string, f: FieldDef, version: number): string[] {
  const where = `version ${version} field ${q(name)}`;
  const out: string[] = [];
  if (!NAME_RE.test(name)) out.push(`${where}: name must match ${NAME_RE} (and never start with "$")`);
  if (f.type === 'enum') {
    if (!f.values.length) out.push(`${where}: enum needs at least one value`);
    if (new Set(f.values).size !== f.values.length) out.push(`${where}: enum has duplicate values`);
  }
  if (f.type === 'string' && f.pattern !== undefined) {
    try {
      new RegExp(f.pattern);
    } catch {
      out.push(`${where}: pattern ${q(f.pattern)} does not compile`);
    }
  }
  if ((f.type === 'number' || f.type === 'integer' || f.type === 'timestamp') && f.min !== undefined && f.max !== undefined && f.min > f.max) {
    out.push(`${where}: min ${f.min} is greater than max ${f.max}`);
  }
  if ('default' in f && f.default !== undefined && !out.length) {
    const bad = validateFieldValue(f, f.default);
    if (bad) out.push(`${where}: default ${q(f.default)} ${bad}`);
  }
  return out;
}

export function checkSchema(def: ObjectTypeDef): string[] {
  const out: string[] = [];
  const who = `type ${q(def.name)}`;
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) out.push(`${who}: name must match ${NAME_RE}`);
  const versions = def.versions ?? [];
  if (!versions.length) {
    out.push(`${who}: needs at least one version`);
    return out;
  }
  versions.forEach((v, i) => {
    if (v.version !== i + 1) out.push(`${who}: versions must be ascending and contiguous from 1 (position ${i + 1} has version ${v.version})`);
  });

  const typeOf = new Map<string, string>();
  for (const v of versions) {
    for (const [name, f] of Object.entries(v.fields ?? {})) {
      out.push(...checkField(name, f, v.version).map((m) => `${who}: ${m}`));
      const seen = typeOf.get(name);
      if (seen && seen !== f.type) out.push(`${who}: field ${q(name)} is ${seen} in an earlier version but ${f.type} in version ${v.version}; use a new field name`);
      if (!seen) typeOf.set(name, f.type);
    }
    if (v.version > 1) {
      if (!v.up) out.push(`${who}: version ${v.version} needs an "up" migration`);
      if (!v.down && v.breaking !== true) out.push(`${who}: version ${v.version} needs a "down" mirror or breaking: true`);
    }
  }

  if (def.compatWrite !== undefined && (!Number.isInteger(def.compatWrite) || def.compatWrite < 1 || def.compatWrite > versions.length)) {
    out.push(`${who}: compatWrite ${q(def.compatWrite)} must be within [1, ${versions.length}]`);
  }
  return out;
}
