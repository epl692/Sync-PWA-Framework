/** checkSchema (schema-rules.md §2). The check that a `down` emits only declared names lives with US6 (T104). */

import { validateFieldValue } from './fields';
import type { JSONValue } from '@sync/core';
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
  if (f.type === 'blob' || (f.type === 'list' && f.of === 'blob')) {
    if (f.accept !== undefined) {
      if (!f.accept.length) out.push(`${where}: accept needs at least one media type`);
      for (const a of f.accept) if (!/^[\w.+-]+\/([\w.+-]+|\*)$/.test(a)) out.push(`${where}: accept entry ${q(a)} is not a media type such as "image/*" or "application/pdf"`);
    }
    if (f.maxBytes !== undefined && (!Number.isSafeInteger(f.maxBytes) || f.maxBytes < 1 || f.maxBytes > 16 * 1024 ** 3)) {
      out.push(`${where}: maxBytes must be an integer from 1 to 16 GiB`);
    }
  }
  if ('default' in f && f.default !== undefined && !out.length) {
    const bad = validateFieldValue(f, f.default);
    if (bad) out.push(`${where}: default ${q(f.default)} ${bad}`);
  }
  return out;
}

/** A sample value of the right type, for test-running `down`. */
function sample(f: FieldDef): JSONValue {
  switch (f.type) {
    case 'string':
    case 'ref':
      return 'a';
    case 'number':
    case 'integer':
    case 'timestamp':
      return 1;
    case 'boolean':
      return true;
    case 'enum':
      return f.values[0] ?? 'a';
    case 'json':
      return {};
    case 'list':
      return [];
    case 'blob':
      return { $blob: 1, id: 'A'.repeat(43), size: 1, type: 'a/b', space: 's', scope: 's', keyId: '0'.repeat(16) };
  }
}

/** Every name a version's `down` can emit must be declared by the version below it (research R-07). */
function checkDown(def: ObjectTypeDef, who: string): string[] {
  const out: string[] = [];
  const versions = def.versions ?? [];
  for (const v of versions) {
    if (v.version < 2 || !v.down) continue;
    const target = versions[v.version - 2];
    if (!target) continue;
    const declared = new Set(Object.keys(target.fields));
    const names = Object.keys(v.fields);
    const inputs: Array<Record<string, JSONValue>> = [
      ...names.map((n) => ({ [n]: sample(v.fields[n]!) })),
      ...names.map((n) => ({ [n]: { $unset: true } as JSONValue })),
      Object.fromEntries(names.map((n) => [n, sample(v.fields[n]!)])),
    ];
    for (const input of inputs) {
      let result: Record<string, unknown>;
      try {
        result = v.down(input);
      } catch (e) {
        out.push(`${who}: version ${v.version} down() threw for ${JSON.stringify(Object.keys(input))}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      for (const name of Object.keys(result)) {
        if (!declared.has(name)) out.push(`${who}: version ${v.version} down() emitted ${q(name)}, which version ${v.version - 1} does not declare`);
      }
    }
  }
  return [...new Set(out)];
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

  out.push(...checkDown(def, who));

  if (def.compatWrite !== undefined && (!Number.isInteger(def.compatWrite) || def.compatWrite < 1 || def.compatWrite > versions.length)) {
    out.push(`${who}: compatWrite ${q(def.compatWrite)} must be within [1, ${versions.length}]`);
  }
  return out;
}
