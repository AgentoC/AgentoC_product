# Contributing

This source tree is being prepared for public release. Before proposing a
change, run the relevant tests in an isolated development environment; do not
use production accounts, workspaces, or credentials as fixtures.

Useful checks from the repository root include:

```sh
node scripts/check-public-boundary.mjs
node tests/test-public-boundary.mjs
node tests/test-redirect-sensitive-headers.mjs
node --test --test-concurrency=1 tests/test-harness-registry.mjs tests/test-harness-policy.mjs tests/test-provider-contract.mjs tests/test-claude-adapter.mjs
node --test --test-concurrency=1 tests/test-accounts-server.mjs tests/test-demo-account-session.mjs tests/test-turn-broker-capability.mjs
```

For the P2P host, run `go test ./...` in `p2p/`. Android contributor build and
test setup is described in the main README. The broader `npm test` suite is
still being verified across operating systems; a partial test result must not be
reported as complete cross-platform coverage.

Keep private configuration, keys, service data, personal screenshots, build
outputs, and test instance data outside the Git-visible tree. The boundary script
checks file names and locations only; it is not a content-level secret scan.

When changing a runtime or protocol, add or update a test for the behavior and
describe platform-specific limitations in the change. Respect the existing
local-web and remote-access security boundaries; do not assume that one implies
the same authentication model for the other.
