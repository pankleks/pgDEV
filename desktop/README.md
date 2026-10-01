# Native desktop migration

This is a parallel implementation, not the completed replacement. The existing
Vue/Fastify application remains intact as the behavioral reference.

## Development

Install the Tauri 2 prerequisites for your OS (Rust stable, platform compiler,
and platform WebView development dependencies), then from the repository root:

```sh
npm install
npm run dev:desktop
```

Frontend-only checks: `npm run check:desktop` and `npm run build:desktop:web`.
Rust checks: `cargo check --workspace` and `cargo fmt --all -- --check`.
Lints: `cargo clippy --workspace --all-targets --locked -- -D warnings`.
Installer build: `npm run build:desktop`.

Core tests: `cargo test -p pgdev-core`. Opt-in live PostgreSQL tests:
`cargo test -p pgdev-core --test postgres -- --ignored` (requires
`PGDEV_TEST_URL` in the environment or the gitignored root `.env`). They use
temporary tables, not persistent tables or scratch databases.

Catalog parity tests: `cargo test -p pgdev-core --test catalog -- --ignored`.
These require CREATEDB privileges and npm development dependencies. They create
unique PID-suffixed scratch databases, compare Rust metadata and DDL against the
existing backend through a test-only Node helper, and clean up after assertions.
Run all core tests with `cargo test -p pgdev-core --locked -- --include-ignored`.
Browser-tree helper tests: `node --import tsx --test test/native-catalog-tree.mjs`.

Query transport types in `src/generated/contracts.ts` come from Rust DTOs.
Regenerate them with `npm run generate:desktop:types`; the regular Rust test
suite checks that they have not drifted. Node.js is used only for this build task.

Node.js is a build tool only. The installed application communicates directly
with the Rust core through Tauri IPC; it does not run a Node sidecar or HTTP API.
Opening Vite in a browser is not a supported application mode.

## Current prototype

- Connection URI, PostgreSQL 14+ validation, verified TLS where requested.
- Dedicated query sessions per tab (maximum five busy/pinned sessions), with
  idle-slot reclamation and an idle reaper. Creating a client does not lock the
  global registry or block cancellation of queries on other connections.
- Statement splitting handles PostgreSQL quotes, dollar bodies, nested
  comments and `standard_conforming_strings`; errors have batch-relative
  Unicode character positions.
- Typed columns (names, PostgreSQL type names and OIDs) with lossless text for
  bigint, numeric, JSON, temporal, arrays and custom types. Boolean and small
  integer values retain the existing JSON representation.
- Implicit atomic batches, autocommit routing and user-managed transactions
  pinned by transaction identity. Stale identities execute no SQL, and failed
  manual transactions remain open for user recovery with ROLLBACK.
- Only the final result is pageable through a PostgreSQL cursor. Earlier and
  manual-transaction result sets are bounded and drained, with explicit limit
  flags. Lookahead paging preserves every row, including an exact final page.
- Query cancellation on a separate socket, statement timeout, disconnect.
- Session close/disconnect aborts the driver without waiting for a query mutex;
  PostgreSQL rolls back the terminated connection's open transaction.
- Svelte 5 shell and Monaco with local worker assets, selection execution,
  type headers, load-more and manual commit/rollback controls.
- Object catalog for tables, views, functions, types and sequences, with
  columns, indexes, constraints, triggers and built-in completion metadata.
- Snapshot-consistent DDL for all eight object kinds. A separate bounded catalog
  pool keeps browsing independent of pinned query-tab transactions.
- Svelte object-browser integration with search and read-only DDL previews that
  leave query text and transactions unchanged. This is not the final browser UI.

The query engine uses prepared descriptions for metadata and text protocol for
user values, avoiding lossy generic binary decoding. Page size defaults to 500
and accepts 1–10000; pages exceeding an 8 MiB memory budget fail explicitly
rather than silently discard cursor rows. Statement timeout still bounds the
work performed by PostgreSQL. The initial raw-text API remains a legacy test
fixture and is no longer exposed as a Tauri command.

Notices, declared character lengths, editable-grid metadata, exact utility
command tags, row/table editing, persistence, file operations and
MCP migration are still outstanding. The prototype UI is not the final 1:1 UI.
The production build has been verified locally on Windows; CI also checks
macOS/Linux, but their installers still require validation on those platforms.

TLS currently uses the system trust store and verifies server certificates.
Connection URIs without `sslmode` retain the legacy non-TLS default; use
`sslmode=require` to explicitly request encrypted, certificate-verified access.
Custom CA certificates and explicit compatibility with legacy self-signed
connections require a dedicated configuration design; verification must not be
silently disabled.

The Rust packages are unpublished migration scaffolding (`0.0.0`), not a new
application release version. Existing package versions have not been changed.
