# Desktop architecture and releases

## Process boundaries

- `desktop/main.mjs` owns the single application instance, window, native dialogs/files, clipboard, storage, and backend lifecycle.
- `desktop/preload.cjs` exposes named operations only. The renderer is sandboxed, context-isolated, and has no Node integration or raw IPC access.
- `desktop/backend.mjs` runs Fastify/PostgreSQL in an Electron utility process. It binds port 0 on `127.0.0.1` and reports the address to its parent. Desktop API requests require a per-launch secret; renderer code never receives it.
- AI events are streamed in main and delivered through a narrow subscription. The persistent MCP token authorizes only agent tool routes, not the desktop API.
- `bin/pgdev-mcp.mjs` is build input for a standalone Node SEA executable. Its stdin/stdout remain MCP-only. It does not own database connections.
- Native API and persistence modules are independent of the UI framework and were retained through the [Svelte migration](svelte.md).

The frontend loads from `pgdev://app`, not a localhost website. Vite is used only during development. Navigation and new windows are restricted; the one approved external link opens the project on GitHub. Packaged Electron fuses disable RunAsNode and NODE_OPTIONS and require the integrity-checked application archive.

## Persistence

Electron's per-user application-data directory contains:

```text
state/settings.json
state/connections.json    # OS-encrypted credential record, or secret-free metadata
state/pinnedFiles.json    # SQL snapshots and native file references
state/session.json       # Unsaved editor session
mcp-token                # Persistent external-agent token; treat it as a secret
mcp-endpoint.json        # Current loopback address; contains no credentials
desktop.log              # Lifecycle events, no SQL or credentials
```

The app keeps `.bak` records and uses temporary files plus atomic replacement. Corruption triggers backup recovery and preserves the damaged record. If neither primary nor backup is readable, saving that record is disabled rather than overwriting user work. Quit the app before repairing/moving damaged records; make a copy first. Session SQL and pinned snapshots are plain text and can themselves contain sensitive SQL.

Passwords and connection strings are encrypted with Electron `safeStorage`. Linux `basic_text` is explicitly rejected; without a secure keyring, only secret-free connection metadata is saved. The UI warns when credentials cannot be remembered. Uninstall does not automatically erase application data. No browser data is imported, and IndexedDB is not used.

Native reads/writes are limited to files selected in dialogs or authorized references loaded from trusted native storage. CSV pages are awaited and streamed into a same-directory temporary file; a canceled/failed export does not replace the destination. SQL files are limited to 32 MiB. Missing pinned files can still open their stored SQL snapshot.

The backend address is ephemeral. The MCP helper rereads `mcp-endpoint.json` for each tool call, so the copied configuration survives port changes. The endpoint file is removed on orderly shutdown. Keep both it and the token under the user's private application-data directory; same-user process compromise is outside the renderer security boundary. Automatic updates are deferred; updates currently require downloading/installing a new release.

## Local validation

```bash
npm run build
npm run test:unit
npm run test:desktop
npm run test:desktop:smoke
npm run test:desktop:tree
npm run package:desktop
node desktop/scripts/packaged-smoke.mjs
```

Smoke tests use a temporary data directory, check the actual production frontend and Monaco, reject unauthorized API/file requests, initialize the packaged MCP helper, save the editor session on close, and verify backend termination. With `PGDEV_TEST_URL`, they also connect and execute a read-only query through the UI. No production connections are used.

The tree interaction suite runs Electron against Vite with a synthetic catalog (no database required). It checks section/group arrows and every expandable object/category using chevron, name and icon clicks, both during search and without search, and preserves double-click-to-open-DDL behavior. Port 5173 must be available.

macOS and Linux still need native-platform validation: Windows results do not establish cross-platform feature parity. Installer upgrade/uninstall checks, credential-keyring behavior and signed/notarized distribution must be tested before public publication.

## GitHub Actions

### CI

`.github/workflows/ci.yml` runs unit/native tests and unsigned desktop packaging on:

- Windows x64 (`windows-2022`)
- macOS arm64 (`macos-15`, verified by `process.arch`)
- Linux x64 (`ubuntu-24.04`)

A separate PostgreSQL 14/18 matrix exercises live database suites and an Electron database smoke test. Preview installers are workflow artifacts, not public releases. Fork PRs receive no signing secrets.

### Releases

`.github/workflows/release.yml` replaces npm publication. An existing `v<package version>` tag or manual dispatch builds every platform and creates a **draft** GitHub Release only after required jobs pass. The workflow never increments versions, commits, creates tags or publishes a draft automatically. Published releases are not modified. SHA-256 checksums cover every installer/archive.

Before signed releases, configure the `desktop-release` GitHub environment with required reviewers and trusted-tag deployment rules. Set these environment secrets:

| Secret | Purpose |
| --- | --- |
| `WINDOWS_CSC_LINK` | Windows signing certificate (base64 PFX or supported certificate link) |
| `WINDOWS_CSC_KEY_PASSWORD` | Certificate password |
| `MAC_CSC_LINK` | Developer ID Application certificate (base64 P12 or supported link) |
| `MAC_CSC_KEY_PASSWORD` | Certificate password |
| `APPLE_ID` | Apple account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific notarization password |
| `APPLE_TEAM_ID` | Developer team identifier |

Tag-triggered releases require signing configuration for Windows/macOS. For development without credentials, manually dispatch with **unsigned_preview** enabled; the draft is explicitly marked unsigned. Keep signing credentials out of repository files and logs. All third-party Actions are pinned to reviewed commit SHAs.

Release packaging produces Windows NSIS EXE, macOS arm64 DMG/ZIP, and Linux x64 DEB/RPM. Manual review/publishing is required, including checks of installed-app startup, MCP, credentials and upgrades. No Intel/universal macOS build is generated.
