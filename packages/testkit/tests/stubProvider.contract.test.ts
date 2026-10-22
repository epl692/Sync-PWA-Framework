// T082 (and the T036 baseline): the stub provider passes the whole Identity Provider contract suite.
import { createStubIdentityProvider, identityProviderContract } from '../src/spaces';

identityProviderContract('stub', createStubIdentityProvider);
