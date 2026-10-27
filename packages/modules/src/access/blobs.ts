/**
 * The module-facing view of the blob engine (spec 004, M-1, research R-12). The same methods as `Blobs`, but every call
 * is checked against the Spaces the module declared, with the same denial path as the data facade. Not a sandbox: it is
 * the same API-level guarantee as the rest of the access declarations (spec 003 R-10).
 */

import type { Blobs } from '@sync/blobs';
import type { BlobsFacade } from '../types';
import type { Guard } from './guard';

export function createBlobsFacade(engine: Blobs, guard: Guard): BlobsFacade {
  return Object.freeze({
    attach: (source, opts) => {
      guard.space('rw', opts.space);
      return engine.attach(source, opts);
    },
    observe: (ref) => {
      guard.space('r', ref.space);
      return engine.observe(ref);
    },
    request: async (ref, opts) => {
      guard.space('r', ref.space);
      return engine.request(ref, opts);
    },
    open: async (ref, opts) => {
      guard.space('r', ref.space);
      return engine.open(ref, opts);
    },
    toBlob: async (ref, opts) => {
      guard.space('r', ref.space);
      return engine.toBlob(ref, opts);
    },
    cancel: (ref) => {
      guard.space('r', ref.space);
      engine.cancel(ref);
    },
    pin: async (ref) => {
      guard.space('r', ref.space);
      return engine.pin(ref);
    },
    unpin: async (ref) => {
      guard.space('r', ref.space);
      return engine.unpin(ref);
    },
  });
}
