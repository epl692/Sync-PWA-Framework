// Micro-benchmarks for the schema and projection code (npm run bench -w @sync/modules).
import { bench, describe } from 'vitest';
import { migrate } from '../src/schema/migrate';
import { prepareWrite } from '../src/schema/prepare-write';
import { project } from '../src/schema/project';
import { SchemaRegistry } from '../src/schema/registry';
import { validateBody } from '../src/schema/validate';

const reg = new SchemaRegistry().register('m', {
  name: 'item',
  versions: [
    { version: 1, fields: { title: { type: 'string', maxLength: 100 }, done: { type: 'boolean', default: false } } },
    {
      version: 2,
      fields: { name: { type: 'string', maxLength: 100 }, done: { type: 'boolean', default: false }, priority: { type: 'integer', min: 0, default: 0 } },
      up: migrate.all(migrate.rename('title', 'name'), migrate.addDefault('priority', 0)),
      down: migrate.mirrorRename('name', 'title'),
    },
  ],
});
const body = { op: 'update' as const, schemaVersion: 2, fields: { name: 'milk', priority: 3 } };
const stored = { id: 'o1', type: 'm.item', space: 's1', schemaVersion: 1, fields: { title: 'milk', done: false }, clocks: { title: 'c5', done: 'c5' } };

describe('schema', () => {
  bench('validateBody (update, 2 fields)', () => void validateBody(reg, body));
  bench('prepareWrite (create, with down mirror)', () => void prepareWrite(reg, 'create', { name: 'milk' }));
  bench('project (v1 object through one migration)', () => void project(reg, stored));
});
