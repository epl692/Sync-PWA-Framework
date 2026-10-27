/** Builds the ModuleContext a module receives (research R-03). */

import type { JSONValue } from '@sync/core';
import { LiveElement } from '../ui/live-element';
import type { BlobsFacade, DataFacade, ModuleContext, SpacesFacade } from '../types';

export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (m, x) => console.info(m, ...(x === undefined ? [] : [x])),
  warn: (m, x) => console.warn(m, ...(x === undefined ? [] : [x])),
  error: (m, x) => console.error(m, ...(x === undefined ? [] : [x])),
};

const notReady = (what: string) => () => {
  throw new Error(`${what} is not available before the core is open`);
};

/** Data and Spaces access for a context created before the core exists (identity provider and transport factories). */
export const bootFacades = (): { data: DataFacade; spaces: SpacesFacade } => ({
  data: {
    create: notReady('ctx.data'),
    update: notReady('ctx.data'),
    remove: notReady('ctx.data'),
    get: notReady('ctx.data'),
    query: notReady('ctx.data'),
    undo: notReady('ctx.data'),
    history: notReady('ctx.data'),
  } as unknown as DataFacade,
  spaces: { list: notReady('ctx.spaces') as unknown as SpacesFacade['list'] },
});

export function makeContext(o: {
  moduleId: string;
  version: string;
  settings?: Record<string, JSONValue>;
  data: DataFacade;
  spaces: SpacesFacade;
  blobs?: BlobsFacade;
  log: Logger;
}): ModuleContext {
  const prefix = `[${o.moduleId}]`;
  return Object.freeze({
    moduleId: o.moduleId,
    version: o.version,
    settings: Object.freeze({ ...(o.settings ?? {}) }),
    data: o.data,
    spaces: o.spaces,
    ...(o.blobs ? { blobs: o.blobs } : {}),
    ui: Object.freeze({ LiveElement }),
    log: Object.freeze({
      info: (m: string, x?: unknown) => o.log.info(`${prefix} ${m}`, x),
      warn: (m: string, x?: unknown) => o.log.warn(`${prefix} ${m}`, x),
      error: (m: string, x?: unknown) => o.log.error(`${prefix} ${m}`, x),
    }),
  }) as ModuleContext;
}
