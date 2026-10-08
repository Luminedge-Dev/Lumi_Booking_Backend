# AGENTS.md — Luminedge Booking Backend (repo-scoped operating rules)

**Status:** ACTIVE — 2026-10-08
**Scope:** this repository only (`Lumi_Booking_Backend/`).
**Stage:** Stage 12.5 — COMPLETE 2026-10-07 (D-034) + Stage 13 — COMPLETE 2026-10-07 (D-036, stage13-dev only) + Stage 14 — COMPLETE 2026-10-08 (D-037, read-only Mongo → stage13-dev ETL + reconciliation; `scripts/migration/stage14/`) + Stage 15 - COMPLETE 2026-10-08 (D-038, stage13-dev only; Auth/User/Course/Schedule repositories on PostgreSQL via Prisma; Booking/Feedback/Stats/compat still MongoDB) + Stage 16 - NEXT (planning only; not started)
**Target:** D-032 — PostgreSQL + Prisma ORM 7.10.0 foundation is local. HYBRID since Stage 15 (D-038): the TS candidate's Auth/User/Course/Schedule repositories use PostgreSQL (stage13-dev); Booking, Feedback, Stats and legacy compat routes use MongoDB. Existing production remains MongoDB and is untouched.
**Deployment (D-035 ACTIVE):** existing production (`luminedge-server` + MongoDB) stays live and untouched. Stage 13+ work targets local/new staging infrastructure — NEVER old-production conversion. Do not deploy this backend over the current production project; do not Preview against it.

**Stage 11 closure (2026-10-07):** Stage 11 closed with accepted sufficient
production evidence (11.1 PASS; 11.2 project-level Vercel measured, route/
function-level Observability unavailable; 11.3 source-DB cluster facts and
scale measured, tier-limited CPU/memory/IOPS unavailable; 11.4 PASS; 11.5
system-level attribution accepted, route-specific production attribution an
explicit limitation; 11.6 docs lock in
`context/operations/production-resource-baseline.md`).
**Stage 12 closure (2026-10-07):** relational + runtime design locked (D-033
records Option A). **Stage 12.5 closure (2026-10-07):** TypeScript Runtime
Foundation COMPLETE (D-034; old Pass B/C SUPERSEDED by D-035 — no activation
inside existing production). Stage 13 foundation is applied on Neon branch
stage13-dev only. MongoDB remains the
current production source of truth until the controlled Stage 22 cutover;
Stage 17 is rehearsal/readiness only. Interactive
$transaction commit, rollback, and Serializable isolation were proven on
stage13-dev in Stage 13. Booking workflow designs remain Stage 16.

## 1. Workspace context (not tracked by this repo's Git)

When this repository is used inside the full Luminedge workspace, the
canonical architecture/context documentation lives at:

```text
../AGENTS.md                  (workspace operating contract)
../context/                   (Context Pack v5, D-032 baseline)
../resource/PRD.md            (PRD v5.1)
```

Those parent-level workspace documents are **not part of this standalone
backend Git repository** and are not pushed with it. Statements below that
cite them assume the full workspace checkout. See `README.md` for the read order.

## 2. Current vs target (do not confuse)

```text
CURRENT:   Express 4, CommonJS index.js → app.js, native MongoDB, JWT + bcrypt, Vercel.
           TS candidate src/main.ts / src/handler.ts → runtime/bootstrap.ts → src/app.ts
           → router/index.ts (Auth/User/Course/Schedule, secured /schedule/:userId) — implemented + locally verified, NOT activated in existing production (intentional under D-035).
PERSISTENCE (Stage 15, D-038): Auth/User/Course/Schedule repositories -> PostgreSQL via Prisma 7.10 (stage13-dev only, ports + Prisma*Repository, lazy client).
           Booking/Feedback/Stats/legacy compat (+ legacy auth middleware) -> MongoDB native driver. No cross-database atomicity.
           Stage 14 quarantined users/schedules are absent from PostgreSQL by design (no fallback/repair).
TARGET:    PostgreSQL + Prisma ORM 7 + Neon is the full target (Stage 16+ booking, Stage 22 cutover).
LATER:     Better Auth (Stage 18). NEVER: Mongoose (superseded).
```

MongoDB remains the current production source of truth until the controlled
Stage 22 cutover (D-035). Stage 17 is migration rehearsal/readiness only —
no production authority switch there.

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
Home teacher assign (CURRENT Mongo): booking teacher fields + user teacher map = atomic
  (TARGET relational equivalent per Stage 12: bookings compatibility/read-cache
  state + authoritative teacher_assignments state = atomic; never recreate
  teachersBySchedule in PostgreSQL)
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
pnpm test                    (670/670)
pnpm test:characterization   (119/119 legacy contracts)
pnpm test:architecture       (225/225)
pnpm test:transaction        (20/20, real ephemeral replica set)
pnpm test:stage14:mongo      (6/6, real ephemeral Mongo; ETL keyset/resume)
pnpm test:postgres           (2/2, Neon branch stage13-dev only)
git diff --check
```

Stage 14 ETL commands (Mongo is READ ONLY; writes only to a verified stage13-dev):

```text
pnpm migration:stage14:dry-run     extract + transform + validate, no PostgreSQL write (default)
pnpm migration:stage14:load         requires --target stage13-dev (already in the script)
pnpm migration:stage14:reconcile    SELECT-only comparison against stage13-dev
```

Never point these at Neon production or at existing production; never print
connection strings; reports under `_migration/` stay local (gitignored).

Never claim tests passed unless they ran. After meaningful work, update the
workspace `context/progress-tracker.md` (parent checkout, not pushed with this repo).

## 8. Git safety

Leave changes local/uncommitted unless Arnab explicitly requests writes.
Never commit secrets (`.env`, tokens, SMTP credentials, `CRON_SECRET`).
Read-only inspection: `status`, `diff`, `diff --stat`, `diff --check`, `log`.
