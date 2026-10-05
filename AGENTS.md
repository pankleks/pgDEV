# pgDEV — agent instructions

## Git rules (hard requirement)

- **Never commit or push without the user's explicit approval** — this includes
  amending, force-pushing, and creating commits of any kind.
- When work is ready, summarize what changed and ask; commit and push only
  after the user says so.
- `git status` / `git diff` / `git log` inspection is fine at any time.
- never analyze files in `node_modules`, `dist` folder
- analyze `test` folder only in case task calls explicitly for testing
- search web if needed (libs docs, db docs, solutions)
- never update package version, it's user decision

## Project facts

- npm workspaces monorepo: `server/` (Fastify + TypeScript, NodeNext),
  `web/` (Vue 3 + Monaco + Vite), and an Electron shell in `desktop/`.
- Desktop-only delivery; Node/npm are development tools, not user prerequisites.
- Build gate: `npm run build` (vue-tsc + vite + server tsc + desktop/MCP bundles).
- Tests: `npm test` (unit + live suites; live suites need `PGDEV_TEST_URL`
  from `.env`; `npm run test:desktop` covers native/security units and
  `npm run test:desktop:smoke` drives Electron. `PGDEV_DESKTOP=1` adds the
  Electron smoke to `npm test`; Linux needs a display or xvfb).
- Scratch databases are PID-suffixed (`pgdev_*_<pid>`); `.env` is gitignored
  and must never be committed.
- PostgreSQL 14+ is the supported server baseline.
