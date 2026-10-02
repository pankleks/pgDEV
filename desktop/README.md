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
Settings/routing tests: `node --import tsx --test test/native-settings.mjs`.
Formatting/error-position tests: `node --import tsx --test test/native-sql-editing.mjs`.
Parameter-template tests: `node --import tsx --test test/native-parameter-mapping.mjs`.
Native-file lifecycle tests: `node --import tsx --test test/native-query-files.mjs`.
Streaming CSV tests: `node --import tsx --test test/native-query-export.mjs`.
Clipboard TSV tests: `node --import tsx --test test/native-query-clipboard.mjs`.
Native clipboard payload validation: `cargo test -p pgdev-desktop --locked`.

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
- Explicit password-free connection profiles in the desktop IndexedDB, separate
  from SQL tabs and settings: ten saved endpoints, named updates, forget actions,
  and stable never-reused profile numbers. Saving strips URI passwords (userinfo
  and query parameter); only known non-secret URI options are accepted. Profiles
  never store TLS CA text, passwords, database session IDs or transaction state.
  Selecting one populates the form without connecting and clears previous secret
  input; enter its password/CA again. An optional password override is encoded
  only for the connection request. No automatic legacy-profile import, password
  persistence, OS credential-vault integration or last-connection auto-reconnect
  is provided yet. Corrupt/unreadable records disable writes instead of being
  overwritten. Writes are serialized/retryable and awaited on normal exit.
  Profile tests: `node --import tsx --test test/native-connection-profiles.mjs`.
- Optional custom TLS CA: paste exactly one PEM certificate (up to 64 KiB) in
  the connection form and use `sslmode=require`. It augments system trust without
  disabling certificate or hostname verification; plaintext/prefer modes with
  a custom CA are rejected before connecting. The same connector is retained
  for query sessions, catalog clients and cancellation sockets. CA text is not
  persisted and is cleared from the form on successful connection. PEM bundles,
  client certificates and insecure/self-signed bypass modes are not supported.
  Offline loopback tests perform real PostgreSQL SSL negotiation and TLS startup,
  verifying trusted self-signed success and rejection of untrusted, expired or
  hostname-mismatched certificates. They run with normal core tests and in the
  three-platform CI matrix. Full queries/catalog/cancellation against a TLS-enabled
  PostgreSQL still require end-to-end validation on each supported platform.
- Dedicated query sessions per tab (maximum five busy/pinned sessions), with
  idle-slot reclamation and an idle reaper. Creating a client does not lock the
  global registry or block cancellation of queries on other connections.
- Statement splitting handles PostgreSQL quotes, dollar bodies, nested
  comments and `standard_conforming_strings`; errors have batch-relative
  Unicode character positions.
- Command results retain node-postgres's short command names (`CREATE`, `ALTER`,
  `START`, etc.), normalize `END`/`ABORT` aliases, and identify the outer operation
  of `WITH` statements without confusing nested CTE bodies, quotes or comments.
  Live parity tests compare names and affected-row counts to node-postgres using
  session-local temporary objects (`common_utility_names_and_counts_match_original_transport`).
  These are syntax-derived labels, not complete wire command tags: dynamic
  `EXECUTE` and a `COMMIT` that rolls back an aborted transaction remain gaps.
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
- Prototype settings dialog: editor font (8–32 px, default 14), statement timeout
  (1–600 seconds, default 30) and query/page row limit (1–10000, default 500).
  Font changes update Monaco options without resetting models or undo history.
  Timeout is captured when connecting and applies to that connection's Rust
  query/catalog sockets; changing it requires reconnecting, as in the original.
  Row limits apply to the next run or fetch, leaving existing results unchanged.
  Preferences are stored separately from SQL tabs, with serialized/retryable
  writes, autosave and exit flush. Read failures disable preference writes but
  allow temporary settings. Cancel leaves the draft unapplied; reset affects
  only the draft until Apply. Other original settings remain to be migrated.
- Catalog-driven Monaco completion, hover and function signature help, shared
  with the original editor through framework-independent provider factories.
  Aliases, quoted identifiers, CTEs, routine-body symbols, overloads and built-ins
  use the existing SQL parsing rules. Providers read the latest Rust catalog,
  are scoped to their owning model and are disposed with the Svelte editor.
- The same PostgreSQL grammar, dark theme and Monaco editor contributions as
  the original UI, including the suggest and parameter-help widgets.
- Shared PostgreSQL SQL formatter via toolbar, context menu and
  Ctrl/Cmd+Shift+F. Whole-document or selection formatting uses undoable edits;
  parser failures leave text untouched and appear on the originating tab.
- Model-scoped PostgreSQL error markers, including selection origins and
  Unicode scalar-to-UTF-16 position conversion. Markers are cleared on edits,
  new runs and disconnect, and late failures cannot mark changed SQL. Results
  and transaction messages remain available independently of editor markers.
- Parameter-mapping dialog/Monaco action shared with the original scanner and
  PREPARE/EXECUTE/DEALLOCATE generator. Optional JSON values apply positionally;
  missing values and parameter gaps become NULL. Strings/comments/identifiers
  and dollar-quoted bodies do not introduce parameters. SQL is previewed first
  and applied to the captured document or selection as one undoable edit;
  changed SQL or a different active tab rejects application. Nothing is run
  automatically and database state is not touched. Input sizes, parameter
  indices and nesting are bounded; unsafe JSON integers must be quoted strings.
  Values/previews are not persisted until the script is explicitly applied.
- Native open/save/save-as dialogs for UTF-8 SQL/text files (8 MiB limit).
  Editor shortcuts: Ctrl/Cmd+O, Ctrl/Cmd+S and Ctrl/Cmd+Shift+S.
  Rust owns paths and issues bounded, process-local access tokens; the WebView
  cannot request arbitrary file paths. Dialog cancellation leaves tabs unchanged.
  Clean duplicate opens reuse a tab; dirty copies are preserved. Saving captures
  the original tab/text, so edits during a save remain dirty. File saves never
  execute SQL or change query results/transactions. A saving tab cannot be closed.
- File writes stage and flush a temporary file in the same directory before
  replacement, preserving existing permissions and UTF-8 BOMs on regular saves.
  SHA-256 checks reject observed external changes/deletion rather than overwrite
  silently. This is best-effort conflict detection, not filesystem compare-and-swap.
  Native file access is not restored after restart: session text survives but
  requires Save As or reopening before being associated with a disk file again.
  New/save-as files use UTF-8 without BOM. Native dialog behavior and installer
  integration still require manual validation on all three platforms.
- Streaming native CSV export with the original BOM, escaping and spreadsheet
  formula-neutralization rules. Loaded rows and remaining cursor pages go to
  bounded IPC chunks (1 MiB maximum); fetched pages are not retained in the UI.
  Export is scoped to its captured tab/result while other tabs remain usable.
  Failed/cancelled exports abort staging and leave the destination untouched;
  failed/lost fetches retire paging and require a rerun, preventing partial
  re-exports from masquerading as complete data. A first-page write failure or
  picker cancellation leaves the cursor retryable. Limited, non-pageable results
  export only their available rows and are explicitly labelled as limited.
  Native output is capped at 1 GiB with at most eight staged exports. Destination
  conflicts are checked before atomic replacement (best effort, not CAS).
  Closing/disconnecting is blocked until export stops; cancellation uses the
  query socket's separate cancellation path when a fetch is in flight.
- Explicit copying of loaded result rows to the system clipboard as plain TSV,
  using the original escaping, spreadsheet-formula neutralization and lossless
  textual value rules. It never fetches cursor pages or changes database state;
  partial/limited/consumed grids are labelled as loaded-only copies. UTF-8 output
  is capped at 8 MiB on both sides of IPC, with CSV export offered for larger data.
  Copy captures the originating result and suppresses stale status after reruns.
  Native clipboard access is write-only through a custom bounded command; no
  read/clear/image/HTML permissions or browser clipboard fallback are enabled.
  Clipboard failures are visible and leave query results untouched. Manual
  clipboard validation still requires an interactive desktop on each platform.
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

Exact utility command tags, final 1:1 table-editor UI, remaining settings/connection persistence, pinned files/import and
MCP migration are still outstanding. The prototype UI is not the final 1:1 UI.
The production build has been verified locally on Windows; CI also checks
macOS/Linux, but their installers still require validation on those platforms.

TLS uses the system trust store plus an optional custom CA and verifies server certificates.
Connection URIs without `sslmode` retain the legacy non-TLS default; use
`sslmode=require` to explicitly request encrypted, certificate-verified access.
Legacy self-signed connections must explicitly trust a supplied certificate;
there is no insecure bypass. Loopback handshake tests have passed on Windows;
TLS-enabled PostgreSQL end-to-end and macOS/Linux execution remain pending.

The Rust packages are unpublished migration scaffolding (`0.0.0`), not a new
application release version. Existing package versions have not been changed.
