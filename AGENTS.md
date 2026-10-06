# AGENTS.md — Luminedge Booking Backend (repo-scoped operating rules)

**Status:** ACTIVE — 2026-10-06
**Scope:** this repository only (`luminedge_booking_backend/`).
**Stage:** Stage 11 — Production Workload & Resource Baseline — IN PROGRESS (TELEMETRY DEFERRED) + Stage 12 — DESIGN ONLY (parallel).
**Target:** D-032 — PostgreSQL + Prisma ORM 7 + Neon preferred (NOT implemented).

## 1. Workspace context (not tracked by this repo's Git)

When this repository is used inside the full Luminedge workspace, the
canonical architecture/context documentation lives at:

```text
../AGENTS.md                  (workspace operating contract)
../context/                   (Context Pack v5, D-032 baseline)
../resource/PRD.md            (PRD v5.0)
```

Those parent-level workspace documents are **not part of this standalone
backend Git repository** and are not pushed with it. Statements below that
cite them assume the full workspace checkout. See `README.md` for the read order.

## 2. Current vs target (do not confuse)

```text
CURRENT:   Express 4, CommonJS index.js → app.js, native MongoDB, JWT + bcrypt, Vercel.
           TS candidate src/server.ts → src/app.ts exists (Auth/User/Course/Schedule) — NOT activated.
TARGET:    PostgreSQL + Prisma ORM 7 + Neon preferred — NOT installed, no prisma/ exists.
LATER:     Better Auth (Stage 18). NEVER: Mongoose (superseded).
```

MongoDB remains authoritative until controlled Stage 17 cutover.

## 3. Protected production behavior

Do not modify these to make the TS candidate cleaner:

```text
index.js, app.js, config/**, middleware/**, routes/**,
jobs/**, scripts/**, emailSender.js, vercel.json
```

Preserve `/api/v1` paths and caller-visible contracts unless a deliberate,
approved, tested contract migration changes them. Never trust request-body
identity/role/entitlement/capacity claims — derive the actor from verified
backend auth (live user reload, blocked/deleted rejection).

## 4. Layer rules

```text
Route       → method/path + middleware + controller only
Controller  → HTTP boundary; no persistence queries
Service     → business rules, authorization, transaction orchestration; no req/res
Repository  → persistence only; no authorization policy
```

Module-first: features live under `src/app/modules/<module>/`. No global
`controllers/`/`services/`/`repositories/`. New TypeScript uses
`import`/`export`; legacy interop stays under `src/app/compat/`.

## 5. Transactions (permanent invariants)

```text
Home booking:        booking insert + credit decrement = atomic
Test Center booking: seat decrement + credit decrement + booking insert = atomic
Cancellation:        delete/cancel + seat restore + credit restore = atomic
Home teacher assign: booking update + user teacher-map update = atomic
```

Never replace atomic behavior with separate non-transactional writes.

## 6. Prisma safety (stage-gated)

Prisma 7 only (`prisma@7`, `@prisma/client@7`, `@prisma/adapter-neon@7`) and
only from Stage 13 with explicit approval. Never run `migrate reset`,
`db push`, or `migrate dev` against shared/staging/production. Prisma queries
live in repositories only — never in controllers.

## 7. Verify before finishing

```text
pnpm typecheck
pnpm test                    (557/557 baseline at Stage 10.5 closure)
pnpm test:transaction        (14/14, real ephemeral replica set)
git diff --check
```

Never claim tests passed unless they ran. After meaningful work, update the
workspace `context/progress-tracker.md` (parent checkout, not pushed with this repo).

## 8. Git safety

Leave changes local/uncommitted unless Arnab explicitly requests writes.
Never commit secrets (`.env`, tokens, SMTP credentials, `CRON_SECRET`).
Read-only inspection: `status`, `diff`, `diff --stat`, `diff --check`, `log`.
