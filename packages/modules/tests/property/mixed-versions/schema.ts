// The schemas used by the mixed-version tests: `item` v1 (title, done) and v2 (renamed to name, plus priority).
import { migrate } from '../../../src/schema/migrate';
import type { ModuleDefinition, ObjectTypeDef } from '../../../src/types';

const v1 = { version: 1, fields: { title: { type: 'string' as const, maxLength: 20 }, done: { type: 'boolean' as const, default: false } } };
const v2 = {
  version: 2,
  fields: {
    name: { type: 'string' as const, maxLength: 20 },
    done: { type: 'boolean' as const, default: false },
    priority: { type: 'integer' as const, min: 0, max: 9, default: 0 },
  },
  up: migrate.all(migrate.rename('title', 'name'), migrate.addDefault('priority', 0)),
  down: migrate.mirrorRename('name', 'title'),
};

const access = { spaces: { read: 'any' as const, write: 'any' as const } };
const mk = (version: string, versions: ObjectTypeDef['versions']): ModuleDefinition => ({ id: 'app', version, access, provides: { types: [{ name: 'item', versions }] } });

export const appV1 = mk('1.0.0', [v1]);
export const appV2 = mk('2.0.0', [v1, v2]);
/** Version 2 without a `down`: older peers sync and keep everything, but do not see renamed fields change. */
export const appV2NoDown = mk('2.0.0', [v1, { ...v2, down: undefined, breaking: true }]);
