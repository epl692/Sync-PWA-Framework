# @sync/blobs tests

- `unit/`, `property/`, `integration/`, `adversarial/`, `perf/`: Vitest. DOM tests start with `// @vitest-environment jsdom`.
- `contract/`: runs the shared suites from `@sync/testkit` against each `BlobStorage` implementation.
- `vectors/`: known-answer vectors for the blob format (see `vectors/README.md`).
