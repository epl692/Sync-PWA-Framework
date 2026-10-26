/** Pure value checks for one field (schema-rules.md §1). Shared by lint, validation and projection. */

import type { JSONValue } from '@sync/core';
import type { FieldDef } from './types';

const MAX_JSON_BYTES = 64 * 1024;
const MAX_LIST_ITEMS = 256;
const enc = new TextEncoder();

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export function isUnsetMarker(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && (v as Record<string, unknown>).$unset === true;
}

function range(v: number, f: { min?: number; max?: number }): string | undefined {
  if (f.min !== undefined && v < f.min) return `must be at least ${f.min}`;
  if (f.max !== undefined && v > f.max) return `must be at most ${f.max}`;
  return undefined;
}

/** Type and constraints only (not `required`). Returns a message when the value is not acceptable. */
export function validateFieldValue(f: FieldDef, value: JSONValue): string | undefined {
  const base = checkType(f, value);
  if (base) return base;
  const check = 'check' in f ? (f.check as ((v: JSONValue) => string | undefined) | undefined) : undefined;
  if (!check) return undefined;
  try {
    return check(value);
  } catch (e) {
    return `check-threw: ${(e as Error).message}`;
  }
}

/** Type and built-in constraints, without the custom `check`. Used where only the type matters (lenient mode). */
export function checkType(f: FieldDef, value: JSONValue): string | undefined {
  switch (f.type) {
    case 'string': {
      if (typeof value !== 'string') return 'must be a string';
      if (f.maxLength !== undefined && value.length > f.maxLength) return `must be at most ${f.maxLength} characters`;
      if (f.pattern !== undefined && !new RegExp(f.pattern).test(value)) return `must match ${f.pattern}`;
      return undefined;
    }
    case 'number':
      return isNum(value) ? range(value, f) : 'must be a finite number';
    case 'integer':
      return isInt(value) ? range(value, f) : 'must be an integer';
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'must be a boolean';
    case 'timestamp':
      return isInt(value) && value >= 0 ? range(value, f) : 'must be a timestamp (non-negative integer)';
    case 'enum':
      return typeof value === 'string' && f.values.includes(value) ? undefined : `must be one of ${f.values.join(', ')}`;
    case 'ref':
      return typeof value === 'string' && value.length > 0 ? undefined : 'must be a non-empty object id';
    case 'json': {
      const max = f.maxBytes ?? MAX_JSON_BYTES;
      let n: number;
      try {
        n = enc.encode(JSON.stringify(value)).byteLength;
      } catch {
        return 'must be JSON';
      }
      return n > max ? `must be at most ${max} bytes` : undefined;
    }
    case 'list': {
      if (!Array.isArray(value)) return 'must be a list';
      const max = f.maxItems ?? MAX_LIST_ITEMS;
      if (value.length > max) return `must have at most ${max} items`;
      for (const item of value) {
        const ok = f.of === 'number' ? isNum(item) : typeof item === f.of;
        if (!ok) return `items must be ${f.of}`;
      }
      return undefined;
    }
  }
}

/** True when the field definition itself marks the field required. */
export function isRequired(f: FieldDef): boolean {
  return 'required' in f && f.required === true;
}
