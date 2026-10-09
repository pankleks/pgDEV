<img src="pgDEV.png" width="128" alt="pgDEV icon">

**pgDEV** is an IDE for PostgreSQL, built around productivity, simplicity, and a smooth developer experience.

It integrates with the AI coding harness of your choice, bringing AI-assisted development directly into your PostgreSQL workflow.


# 1. Start

Download the installer for your platform from [GitHub Releases](https://github.com/pankleks/pgdev/releases):

| Platform | Build |
| --- | --- |
| Windows | x64 installer (`.exe`) |
| macOS | Apple Silicon / arm64 (`.dmg` or `.zip`) |
| Linux | x64 (`.deb` or `.rpm`) |

Install and open **pgDEV**. You need a PostgreSQL server (14 or newer), but **not Node.js, npm, or a separate browser**. Preview builds may be unsigned; signed public releases require the project's signing credentials.

The database service runs inside an isolated Electron utility process. Closing pgDEV saves the editor session, stops queries and rolls back open transactions. Application updates are manual initially.

![Not connected](docs/images/manual/01-app-not-connected.png)

> Click **Not connected** to setup first connection.

# 2. Connections

Parameters or a `postgres://…` connection string, with optional SSL. Connections persist on this device and can auto-connect on startup. The dialog manages the saved set — reuse, forget, or disconnect:

![Connect dialog](docs/images/manual/02-connect-dialog.png)

The badge shows the live connection as `user@host:port/database`.

![Connected](docs/images/manual/03-connected-browser.png)

# 3. Object browser

Section headers carry object counts; expansion survives reload; the refresh button re-reads the schema from the server.

* **Tables** — Columns (name, type, nullability), Indexes, Constraints (PK / FK / unique / check), Triggers.
* **Views** — columns. **Functions** — parameters plus return type, overloads listed separately. **Sequences** — increment, start, type, ownership. **Types** — composite/enum detail rows.
* Prefix grouping for related objects (Settings → *Group objects*).
* Right-click: **Collapse** on parents, **Edit…** on editable tables (section 8). Double-click opens DDL (section 5); double-clicking the empty tab strip opens a fresh query tab.

# 4. Search

One box filters every section; matching is case-insensitive with per-section counters (`Tables 2/4`) and highlighted hits:

![Search](docs/images/manual/06-search.png)

* Spaces are OR (`employee labor`), `+` is AND (`employee+labor`), `"quotes"` are exact.
* A leading/trailing word scopes the kind: `table`, `view`, `function` (`func`, `fn`), `column` (`col`), `parameter` (`param`), `type`, `sequence` (`seq`) — e.g. `fn count`, `col id`. Parameter *names* match (`p_emp` finds its function); argument *types* never do (`integer` matches nothing).
* While filtering, sections force-open and group collapse goes inert; no hits reports `No objects match "…"`.

# 5. DDL tabs

Double-click generates a script built to re-apply verbatim — full `CREATE TABLE` with columns, constraints, indexes and ownership:

![DDL tab](docs/images/manual/07-ddl-tab.png)

Tables, plain views, sequences and functions open **editable**; materialized views open **read-only** as a preview.

# 6. Execution model

`F5` / `Ctrl+Enter` runs the selection if there is one, else the tab. Completions are schema-driven (user objects plus built-ins once typed, never `pg_`-internals), with hover docs and signature help.

![Results](docs/images/manual/04-query-results.png)

* Multi-statement batches run with per-statement result sets; typed column headers, `COPY`/`CSV` export, `N row(s)` footer. Failures land in **Messages**, never as a grid.
* Double-click a cell to inspect its raw value (pretty-printed for JSON/JSONB, with a character count) — the dialog's COPY button is the copy path, and a successful copy closes it.
* Large results page through a server cursor instead of loading everything.
* Statement timeout (configurable, applies to new connections) plus explicit cancellation bound runaway queries.
* Manual transactions can span runs with transaction-id pinning — a conflicting tab gets a 409 rather than joining the wrong transaction. Statements requiring autocommit (`VACUUM`, …) bypass the transaction path.
* Run stays disabled while disconnected, while a query is in flight, or in the read-only `AI` log tab.

# 7. Row editor

Edit pencils appear only when the result carries the table's primary key (`SELECT label FROM …` has none). The dialog locks the key, offers per-type editors with NULL checkboxes where allowed, and keeps SAVE disabled until the first change:

![Edit row](docs/images/manual/08-row-editor.png)

Invalid input (e.g. malformed JSON) is rejected client-side; server rejections (e.g. numeric overflow) arrive in-dialog with the PostgreSQL message — either way the dialog stays open and nothing is lost. A successful save runs a parameterized `UPDATE … RETURNING` and patches the grid from the returned row.

# 8. Table editor

Right-click → **Edit…** covers ordinary and partitioned-parent tables only (partitions inherit shape; foreign tables speak a different DDL):

![Edit table](docs/images/manual/09-table-editor.png)

Rename, retype (length/precision/scale), nullability, defaults, add/drop columns, table/column comments. **Generate DDL** emits only the changed `ALTER` clauses in apply-safe order (drops → renames → alters → adds → comments) for review. No-ops, locked/PK columns and stale fingerprints (409) are refused with an explanation.

# 9. Helpers

* `Ctrl+Shift+F` formats the selection, or the whole tab when nothing is selected.
* The sliders action builds a `PREPARE` / `EXECUTE` template from `$N` parameters; optional values ride along as a JSON array (e.g. `[1, "text", null]`).
* Tab sessions (open tabs, pinned files) restore across reloads.

# 10. Settings and AI agent (MCP)

![Settings](docs/images/manual/05-settings.png)

Settings are per-device: editor font size, statement timeout for new connections, object grouping by name prefix, and the AI row/size caps. **Reset to defaults** restores everything.

Settings, pinned file references and tab sessions use versioned JSON snapshots in Electron's application-data directory, with atomic replacement and backups. Database credentials use OS-backed encryption; on Linux without a secure keyring, passwords are not persisted. IndexedDB and browser-data migration are not used.

## MCP access

pgDEV exposes an MCP server.

The AI dialog provides a copyable configuration pointing at the bundled **pgdev-mcp** executable. The helper needs no system Node installation and authenticates to the running app with a separate persistent token. It discovers the current loopback port through a native endpoint file, so the configuration survives app restarts. Keep the token private.

Read tools: `query`, `get_schema` (optional `schema`/`table` filters; relation lists truncate past 200 entries), `get_ddl` (`type`/`schema`/`name`, plus `oid`/`parent` to pin overloads and constraints), `get_active_result` (the active tab's grids capped like `query`, plus the last 100 Messages lines — so the agent sees the outcome, including errors, of scripts *you* ran; no database access happens here). Editor tools: `get_active_query`, `set_active_query` (`replace`/`append`/`insert`), `open_query_tab`, `list_tabs`, `activate_tab`, `close_tab`.
