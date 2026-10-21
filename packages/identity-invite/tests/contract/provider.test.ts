// T055: the default provider passes the whole Identity Provider contract suite.
import { identityProviderContract } from '@sync/testkit';
import { createInviteProvider } from '../../src';

identityProviderContract('invite-qr', () =>
  createInviteProvider({ baseUrl: 'https://app.test/', joinTimeoutMs: 5000 }),
);
