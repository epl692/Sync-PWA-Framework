// Infrastructure module: supplies the default invite/QR identity provider. Unlike app modules it may import
// framework packages, because creating the provider is its whole job (spec 003 research R-13).
import { createInviteProvider } from '@sync/identity-invite';
import type { ModuleDefinition } from '@sync/modules';

export default {
  id: 'identity',
  version: '1.0.0',
  provides: { identityProviders: [{ id: 'invite', create: () => createInviteProvider() }] },
} satisfies ModuleDefinition;
