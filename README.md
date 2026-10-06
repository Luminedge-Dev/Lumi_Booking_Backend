# Luminedge Booking Backend

Production booking backend (Express 4 + native MongoDB + JWT/bcrypt).
Active runtime is legacy CommonJS `index.js → app.js`. A parallel TypeScript
candidate lives under `src/` (Auth/User/Course/Schedule migrated; Booking and
Feedback remain legacy). Production MongoDB remains authoritative.

## Current runtime

- `pnpm dev` → `nodemon index.js` (legacy, active)
- `pnpm start` → `node index.js`
- TS candidate (`src/server.ts → src/app.ts`) is tested, NOT activated.
- Vercel entry is still the legacy `index.js` handler.

## Architecture

Route → validation/auth middleware → controller → service/repository → MongoDB,
canonical DTO, compatible API response. Module-first: business features live
under `src/app/modules/<module>/`. Shared technical concerns only in
`src/app/shared/` and `src/app/middleware/`. No new `require()` in new
TypeScript; legacy references stay under `src/app/compat/`.

## Install / test

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test                    (557/557: characterization + architecture + normalization + units)
pnpm test:transaction        (14/14 on a real ephemeral MongoDB replica set)
```

Transaction/concurrency suite uses `mongodb-memory-server-core` (dev-only,
binary 7.0.14 pinned) and never touches production.

## Context read order (full Luminedge workspace)

When this repository is used inside the full Luminedge workspace, the
canonical architecture/context documentation lives at:

```text
../AGENTS.md                  (workspace operating contract)
../context/00-read-first.md
../context/current-state.md
../context/decision-log.md    (D-032 is the current target decision)
../context/architecture.md
../context/backend-modernization-master-plan.md   (canonical roadmap)
../resource/PRD.md            (PRD v5.0)
```

These parent-level workspace documents are not part of this standalone
backend Git repository and are not pushed with it. The repo-scoped agent
rules that ARE tracked here live in `AGENTS.md` (this repository).

## Architecture target (D-032 APPROVED, NOT IMPLEMENTED)

PostgreSQL + Prisma ORM 7 stable + Neon preferred; Express + TypeScript
retained; Mongo IDs preserved initially as strings; Better Auth is a later
phase (after DB stabilization). Prisma/PostgreSQL/Neon are NOT installed and
no `prisma/` exists — do not install or configure them until their explicit
stages (13+). Stage 10.6 Mongoose is SUPERSEDED, never executed.

## Git safety

Leave changes local/uncommitted unless explicitly requested. Only read-only
commands (`status`, `diff --stat`, `diff --check`, `log`) without approval.
Never commit secrets (`.env`, tokens, SMTP credentials).
