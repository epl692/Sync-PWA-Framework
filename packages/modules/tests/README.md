# Tests for @sync/modules

- Layout: `unit/`, `property/` (fast-check), `contract/`, `integration/`.
- DOM tests (custom elements, service worker registration) need a DOM. Put this as the first line of the file:

  ```ts
  // @vitest-environment jsdom
  ```

  Everything else runs in the default Node environment.
- Real browser behavior (install audit, offline reload, runtime module loading) is covered by Playwright in `tests/e2e/`.
