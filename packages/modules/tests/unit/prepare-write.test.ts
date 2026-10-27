// T050: prepareWrite fills defaults for creates and writes at the latest version.
import { describe, expect, it } from 'vitest';
import { prepareWrite } from '../../src/schema/prepare-write';
import { SchemaRegistry } from '../../src/schema/registry';

const reg = new SchemaRegistry().register('m', {
  name: 't',
  versions: [
    { version: 1, fields: { title: { type: 'string' }, done: { type: 'boolean', default: false } } },
    { version: 2, fields: { title: { type: 'string' }, done: { type: 'boolean', default: false }, rank: { type: 'integer', default: 0 }, label: { type: 'string' } }, up: () => ({}), breaking: true },
  ],
});

describe('prepareWrite', () => {
  it('fills defaults on create only, and writes at the latest version', () => {
    expect(prepareWrite(reg, 'create', { title: 'a' })).toEqual({ schemaVersion: 2, fields: { title: 'a', done: false, rank: 0 } });
    expect(prepareWrite(reg, 'update', { title: 'a' })).toEqual({ schemaVersion: 2, fields: { title: 'a' } });
  });
  it('keeps values the caller gave, even falsy ones', () => {
    expect(prepareWrite(reg, 'create', { done: true, rank: 0 }).fields).toEqual({ done: true, rank: 0 });
  });
  it('does not mutate its input', () => {
    const input = { title: 'a' };
    prepareWrite(reg, 'create', input);
    expect(input).toEqual({ title: 'a' });
  });
  it('does not invent values for fields without a default', () => {
    expect('label' in prepareWrite(reg, 'create', {}).fields).toBe(false);
  });
});
