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
Notice-output helper tests: `node --import tsx --test test/native-notices.mjs`.
SQL-provider tests: `node --import tsx --test test/native-sql-providers.mjs`.
Query-tab lifecycle/model tests: `node --import tsx --test test/native-query-workspace.mjs`.
Query-session persistence tests: `node --import tsx --test test/native-query-session.mjs`.

Query transport types in `src/generated/contracts.ts` come from Rust DTOs.
Regenerate them with `npm run generate:desktop:types`; the regular Rust test
suite checks that they have not drifted. Node.js is used only for this build task.

Node.js is a build tool only. The installed application communicates directly
with the Rust core through Tauri IPC; it does not run a Node sidecar or HTTP API.
Opening Vite in a browser is not a supported application mode.

## Current prototype

Native application icons are generated from the root `pgDEV.png` using
`npm exec --workspace desktop -- tauri icon ../pgDEV.png`. The desktop bundles
use PNG (Linux), ICO (Windows) and ICNS (macOS) assets in `src-tauri/icons`.

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
- Multiple SQL tabs with independent results, notices, paging and transaction
  identities. Queries can run in the background while another tab is active.
  Monaco retains each tab's model, undo history, selection and scroll position.
- Closing a tab releases its Rust session, with confirmation before discarding
  SQL, stopping running work or rolling back a transaction. Closing during a
  row write is blocked. Stale responses after close/disconnect are discarded,
  and cancellation must finish before the same tab can start another operation.
  Disconnect preserves SQL text but clears database state on every tab.
  Tab text, order, titles and the active tab are restored across restarts.
- SQL-tab persistence in the WebView's IndexedDB, matching the original
  application's storage approach. A separate `pgdev-desktop` database is used;
  development and packaged applications have separate origins/sessions.
  Autosave runs every 10 seconds, with manual save and awaited save on window
  close. Writes are serialized; failed writes are surfaced and can be retried.
  Failed/corrupt/unsupported reads disable writes to protect the previous session.
  SQL text is stored locally as plaintext: avoid putting secrets in SQL.
  Credentials, connections, results, notices, cursors and transactions are never
  part of the saved session. Forced termination can lose changes since autosave.
- Exit confirmation for running work/open transactions and row/table dialogs.
  A failed exit save keeps the application open; exiting without saving requires
  an explicit choice. Dialog edits themselves are not persisted.
- Catalog-driven Monaco completion, hover and function signature help, shared
  with the original editor through framework-independent provider factories.
  Aliases, quoted identifiers, CTEs, routine-body symbols, overloads and built-ins
  use the existing SQL parsing rules. Providers read the latest Rust catalog,
  are scoped to their owning model and are disposed with the Svelte editor.
- The same PostgreSQL grammar, dark theme and Monaco editor contributions as
  the original UI, including the suggest and parameter-help widgets.
- Object catalog for tables, views, functions, types and sequences, with
  columns, indexes, constraints, triggers and built-in completion metadata.
- Snapshot-consistent DDL for all eight object kinds. A separate bounded catalog
  pool keeps browsing independent of pinned query-tab transactions.
- Svelte object-browser integration with search and read-only DDL previews that
  leave query text and transactions unchanged. This is not the final browser UI.
- Declared varchar/char lengths and editable-grid metadata for conservative
  single-table SELECTs with a complete, unaliased primary key.
- Parameterized single-row updates with fresh catalog validation. Primary keys,
  generated columns and bytea are locked; missing rows fail explicitly. Manual
  updates use the tab transaction; autocommit edits leave its cursor intact.
- Prototype row-edit dialog, NULL controls and refresh of the stored row values.
- Table-editor catalog state with primary/foreign/unique-key badges, locked
  identity/generated/serial columns and a reference-compatible SHA-256 fingerprint.
- Change-only table ALTER generation, including adds/drops, dependency-ordered
  renames (and cycles), type/default/nullability changes and comments. Stale
  fingerprints are rejected against a fresh catalog snapshot. Generation never
  executes the script or joins the tab transaction.
- Prototype table dialog with SQL preview. Scripts are reviewed and executed
  through the query editor, not applied automatically by the dialog.
- PostgreSQL notices/warnings (severity, SQLSTATE, message, detail, hint and
  context) on query, paging and row-update success or failure. Per-operation
  capture is isolated by socket and bounded to 1000 messages / a 1 MiB notice budget;
  omitted messages are explicitly flagged. Messages are not sent to logs.
- Svelte message panel, including notices raised before errors and in update
  triggers. Accumulated paging output is bounded in the frontend as well.

The query engine uses prepared descriptions for metadata and text protocol for
user values, avoiding lossy generic binary decoding. Page size defaults to 500
and accepts 1–10000; pages exceeding an 8 MiB memory budget fail explicitly
rather than silently discard cursor rows. Statement timeout still bounds the
work performed by PostgreSQL. The initial raw-text API remains a legacy test
fixture and is no longer exposed as a Tauri command.

Exact utility command tags, final 1:1 table-editor UI, settings/connection persistence, file operations and
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
