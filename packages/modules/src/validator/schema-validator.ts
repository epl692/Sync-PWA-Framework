/** The PacketValidator that applies schemas to every local write and every incoming packet (FR-005). */

import type { PacketValidator, ValidationResult } from '@sync/core';
import type { SchemaRegistry } from '../schema/registry';
import { validateBody } from '../schema/validate';

export interface SchemaValidator extends PacketValidator {
  /**
   * While the window is open, an incoming packet of an unknown type is deferred (the module that owns it
   * may still be loading). After it closes, such packets are accepted as opaque data (research R-09).
   */
  closeBootWindow(): void;
}

export function createSchemaValidator(registry: SchemaRegistry): SchemaValidator {
  let open = true;
  return {
    id: 'schema',
    phases: ['send', 'apply'],
    closeBootWindow: () => void (open = false),
    validate(phase, _envelope, body): ValidationResult {
      if (!body) return { verdict: 'accept' }; // not decodable yet; other validators judge the envelope
      if (body.type.startsWith('$')) return { verdict: 'accept' }; // system objects belong to spec 002
      const reg = registry.get(body.type);
      if (!reg) return phase === 'apply' && open ? { verdict: 'defer', reason: 'unknown-type' } : { verdict: 'accept' };
      const r = validateBody(reg, body);
      return r.ok ? { verdict: 'accept' } : { verdict: 'reject', reason: `${body.type}${r.field ? '.' + r.field : ''}: ${r.detail}` };
    },
  };
}
