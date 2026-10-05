# Svelte 5 migration

Phase B's code migration is complete. The desktop shell, TypeScript backend,
native storage formats and MCP protocol are unchanged.

## Renderer architecture

- `web/src/main.ts` mounts `App.svelte` using Svelte 5.
- `App.svelte` owns the layout, startup, native file commands, keyboard shortcuts,
  session restoration and close handling. No legacy application is mounted.
- The object browser, connection/row-edit/table-edit dialogs, settings, numeric steppers,
  toggles and the read-only value dialog are Svelte
  components. Their global CSS classes and existing behavior are retained.
- The results panel, tab strip and Monaco host are Svelte components. Monaco models, per-tab
  cursor/scroll state, error markers, formatting/parameter tools, and close guards
  retain their existing contracts. Running SQL is passed through a callback.
- Results retain the existing transaction/cursor state machine. Display updates
  snapshot metadata and copy only the visible row window, not all retained rows.
  Native CSV export captures the owning grid and streams pages to disk.
- Shared stores use native Svelte `$state` through `lib/state.svelte.ts`.
  Read-only metadata views use `$derived`; database/session store APIs and
  native persistence formats are unchanged.
- The temporary adapters, legacy components, Vue runtime, icon package, Vite
  plugin and type checker have been removed. `npm run build` uses svelte-check
  and Vite; Svelte components use runes and callbacks.
- The Node source-test loader compiles `.svelte.ts` modules with Svelte's compiler
  before executing store regressions, rather than substituting a test-only store.

## Verification

`npm run test:desktop:smoke` verifies the existing sandbox, Monaco, API, MCP,
session restart and shutdown contracts.

`npm run test:desktop:svelte` exercises settings updates, clamping, reset,
remount/persistence, parameter/URL connection forms, errors, saved connections,
forget/clear confirmations, disconnect, type-aware row editing, JSON validation,
save errors, captured transaction bindings, and value-dialog clipboard/Escape behavior in Electron.
Table-editor checks cover load errors, unchanged catalog types, locked columns,
type length/scale changes, add/delete/restore, validation, fingerprint echoing,
stale-schema errors, DDL staging without execution, and closing on disconnect.
Browser checks cover all five sections, grouped folders, scoped filtering,
chevrons, context-menu collapse, refresh, escaped schema text, DDL double-clicks,
read-only materialized-view previews, and connection-specific expansion restoration.
Editor checks cover cursor restoration, model-specific undo, cancelled unsaved
closes, drag reordering, close-all teardown/remount, formatting, SQL error markers
and their edit-time clearing, and query execution.
The smoke records Monaco 0.52.x's known word-highlighter disposal cancellations
([upstream #4702](https://github.com/microsoft/monaco-editor/issues/4702)) separately;
other renderer exceptions still fail. No application-level error suppression is added.
Results checks cover cancellation, commit/rollback transaction IDs, multi-result
selection/messages, virtualized scrolling, column resizing and width retention,
NULL/boolean badges, clipboard TSV, paging, and native CSV export with multiline cells.
Application checks cover navigation collapse/resize, parameter-bar focus and
script generation, native SQL open/save shortcuts, and pinned-file open/unpin.
Its database API responses are synthetic; it never opens a database connection.
Linux requires a display or `xvfb-run -a`. Build before running either command.

## Verification limits

Live PostgreSQL validation requires `PGDEV_TEST_URL`. Installer validation on
Linux and macOS still requires their platform runners/manual checks; a local
Windows build does not prove those platforms. Signing, notarization and the
previously identified TLS configuration issue are separate from this migration.
