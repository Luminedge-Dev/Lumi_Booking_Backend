# AGENTS.md — Luminedge Booking Backend (repo-scoped operating rules)

**Status:** ACTIVE — 2026-10-11
**Scope:** this repository only (`Lumi_Booking_Backend/`).
**Stage:** Stages 12.5–16B are implemented in this repo and remain local to the TypeScript candidate. Stage 17 rehearsal preparation is in progress and is not complete. Existing production is still MongoDB.
**Implemented (code, stage13-dev only):** Stage 13 foundation (D-036); Stage 14 read-only Mongo → stage13-dev ETL (`scripts/migration/stage14/`, D-037); Stage 15 Auth/User/Course/Schedule repositories on Prisma (D-038); Stage 16 Booking and Home teacher assignment on Prisma (D-039); Stage 16B five admin User PUTs on Prisma, B1/B2 closed (D-040). `GET /admin/users` and `GET /user/all` (B8), Feedback/TRF, Stats, reminders, and legacy auth middleware still use MongoDB.
**Stage 17 (rehearsal, not a migration):** F1 local snapshot 2026-10-08; F2 Neon API metadata discovery passed; D-041 Approval A accepted parent stage13-dev; Approval B authorized the read-only child preflight. On 2026-10-11 the one-shot catalog preflight against `ep-dark-brook-b4atip73` / `neondb` exited 0 (`../context/evidence/stage17-readonly-preflight-run.txt`): 16 allowlist tables present, foreign-key checks passed, identity counts 0/0/0. That is a catalog PASS. Connection-bound attestation stays open (`apiAttestation: not-approved`). The runner prints `parentApproval: PENDING`; that field does not overturn D-041. `writeAuthority: none`. `cleanupAuthorized: false`. B7 snapshot freshness remains OPEN. ETL, TRUNCATE, cleanup, load, rehearsal writes, and cutover are not authorized.
**Target:** D-032 — PostgreSQL + Prisma ORM 7.10.0. The candidate is hybrid: Auth, User, Course, Schedule, Booking, credit grants, and account-state PUTs use PostgreSQL on stage13-dev; Feedback, Stats, B8 listing GETs, and legacy compat stay on MongoDB. Existing production remains MongoDB and is untouched.
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
current production source of truth until the controlled Stage 22 cutover.
Stage 17 is rehearsal/readiness only and is not complete: the 2026-10-11
catalog preflight passed, and connection-bound attestation plus B7 remain
open. Interactive $transaction commit, rollback, and Serializable isolation
were proven on stage13-dev in Stage 13. Booking workflows were migrated in
Stage 16 (D-039); credit grants and account-state PUTs in Stage 16B (D-040).

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
PERSISTENCE (implemented in this repo, stage13-dev only):
           Auth/User/Course/Schedule (Stage 15), Booking + Home teacher
           assignment (Stage 16), credit grants and account-state PUTs
           (Stage 16B) -> PostgreSQL via Prisma 7.10.
           Feedback/Stats/listing GETs (B8)/legacy compat (+ legacy auth
           middleware) -> MongoDB. Stage 17 has not changed this split.
           No cross-database atomicity.
           Stage 14 quarantined users/schedules are absent from PostgreSQL by design (no fallback/repair).
TARGET:    PostgreSQL + Prisma ORM 7 + Neon is the full target (Stage 16+ booking, Stage 22 cutover).
LATER:     Better Auth (Stage 18). NEVER: Mongoose (superseded).
```

MongoDB remains the current production source of truth until the controlled
Stage 22 cutover (D-035). Stage 17 is migration rehearsal/readiness only —
no production authority switch, and no write authority, there.

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
Home teacher assign: booking teacher state + teacher_assignments = one
  Serializable PostgreSQL transaction in the Stage 16 repository.
  Legacy Mongo routes are untouched. Do not recreate teachersBySchedule.
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
pnpm test
pnpm test:characterization
pnpm test:architecture
pnpm test:transaction          (real ephemeral replica set)
pnpm test:stage14:mongo        (real ephemeral Mongo; ETL keyset/resume)
pnpm test:postgres             (Neon branch stage13-dev only)
git diff --check
```

The 2026-10-08 copy of this file recorded 670/670, 119/119, 225/225, 20/20,
6/6, and 2/2. Those figures are historical. Do not repeat them as a current
result unless that command was run again.

Stage 14 ETL commands (Mongo is READ ONLY; writes only to a verified stage13-dev):

```text
pnpm migration:stage14:dry-run     extract + transform + validate, no PostgreSQL write (default)
pnpm migration:stage14:load         requires --target stage13-dev (already in the script)
pnpm migration:stage14:reconcile    SELECT-only comparison against stage13-dev
```

Never point these at Neon production, at `stage17-rehearsal`
(`ep-dark-brook-b4atip73`), or at existing production. The Stage 14 loader
stays pinned to stage13-dev / `ep-rapid-bread-b4gi8ftb`. Never print
connection strings. Reports under `_migration/` stay local (gitignored).

Stage 17 read-only preflight evidence is catalog-only. It does not authorize
`migration:stage14:load`, cleanup, TRUNCATE, or a rehearsal write.

Never claim tests passed unless they ran. After meaningful work, update the
workspace `context/progress-tracker.md` (parent checkout, not pushed with this repo).

## 8. Git safety

Leave changes local/uncommitted unless Arnab explicitly requests writes.
Never commit secrets (`.env`, tokens, SMTP credentials, `CRON_SECRET`).
Read-only inspection: `status`, `diff`, `diff --stat`, `diff --check`, `log`.
