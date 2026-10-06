# tools/migration — Stage 10.5 Canonical Data Contract & Normalization Tooling
# (closure patch 2026-10-06, D-031 addendum)

**Not wired into `src/app/**`.** Nothing in this directory is imported by
the running application this stage, and nothing here imports from
`src/app/**`, `routes/**`, `middleware/**`, `app.js`, or `index.js` — see
`tests/architecture/migration-tooling-boundary.test.ts`.

**Not run against any real cluster.** Every normalizer is proven only
against hand-built fixtures (`tests/normalization/*.test.ts`). This
directory never reads `process.env.MONGODB_URI`/`DEST_MONGODB_URI`.

## What this is

A framework-neutral canonical data contract (see
`context/canonical-data-contract.md`) plus pure, side-effect-free
normalizer functions for the fields Stage 6's database audit
(`context/database-profile.md`, `database-canonical-models.md`,
`database-normalization-policy.md`) found to be mixed-BSON-type or
enum-drifted across `users`, `courses`, `schedules`, and `bookingMock`.

Every normalizer returns a `NormalizationResult<T>` (`migration.types.ts`):
`{ ok: true, value, warnings, changes, quarantined }` or
`{ ok: false, errors }`. A transformation is always reported as a `change`,
never applied silently. Error/warning objects never carry raw field values
(PII risk — passwords, passport numbers, emails) — only type labels and,
for errors, the document's own `_id` for triage.

**Closure-patch addition:** each entity also has one whole-document
normalizer (`normalize{User,Course,Schedule,Booking}Document`) that
explicitly constructs the canonical object field-by-field from its
`*_CONTRACT` registry — never spreads the raw input, so a field not
declared in the contract is dropped (the actual field-leakage protection).
Each `FieldContractEntry` now also carries a
`targetDisposition: "INCLUDE" | "EXCLUDE" | "QUARANTINE"`, independent of
its Stage 6 `classification`: `INCLUDE` fields are written into the
canonical object (after normalization, if `NORMALIZE_ON_READ`); `EXCLUDE`
fields are omitted entirely; `QUARANTINE` fields are surfaced in the
result's `quarantined` array for manual review — never silently included,
never silently dropped.

## What this is not

- Not a Mongoose schema. Field types here describe the **persistence**
  target; Stage 10.6 compiles these contracts into actual Mongoose schemas
  that **validate** already-normalized data — they do not re-implement this
  coercion logic via schema casts/transforms.
- Not a real migration. No document from any real database — source or
  destination — is read or written by this code. Running an actual
  migration (old cluster → normalize → validate → write → new cluster) is a
  separate, future, explicitly out-of-scope operation.
- Not exhaustive on product decisions. Fields Stage 6 classified
  `INVESTIGATE` are `QUARANTINE`-disposed (surfaced, not resolved) and
  `IGNORE_AS_HISTORICAL` fields are `EXCLUDE`-disposed (omitted) — see each
  `*.contract.ts` file and `canonical-data-contract.md`. As of the closure
  patch, the field *contracts* themselves are complete (every legitimate
  persisted field is covered), but the underlying product questions on
  `QUARANTINE` fields (e.g. `resultsBySchedule.*.feedback`/`.marks`'s
  string/object polymorphism) remain exactly as unresolved as Stage 6 left
  them.
- `schedules.testType`, `bookingMock.testType`, and `bookingMock.status`
  are **fully closed** enums (audit-confirmed complete via user-supplied
  `luminedge-database-schema.pdf` excerpts, cross-verified against this
  repo's own pre-existing Stage 6 totals wherever independently checkable)
  — anything outside the canonical set/known alias is now **rejected**, not
  passed through with a warning. `schedules.status` and `users.status`'s
  audited `null` each keep one specifically-identified, documented anomaly
  (rejected with its own distinct code) rather than a generic
  "uncharacterized" catch-all for everything unfamiliar.

## Files

- `migration.types.ts` — `NormalizationResult<T>` and the shared
  `FieldContractEntry`/`FieldClassification` types (reusing Stage 6's own
  taxonomy: `PRESERVE`, `NORMALIZE_ON_READ`, `NORMALIZE_ON_WRITE_FOR_NEW_DATA`,
  `FUTURE_DATA_MIGRATION`, `INVESTIGATE`, `IGNORE_AS_HISTORICAL`).
- `coercion.ts` — generic, entity-agnostic BSON-shape primitives.
- `user.contract.ts` / `user.normalizer.ts`
- `course.contract.ts` / `course.normalizer.ts`
- `schedule.contract.ts` / `schedule.normalizer.ts`
- `booking.contract.ts` / `booking.normalizer.ts`

Each `*.contract.ts` is a typed, machine-checkable mirror of its entity's
section of `context/canonical-data-contract.md` — validated by
`tests/normalization/canonical-contract.test.ts`, which fails if the two
drift apart (a `NORMALIZE_ON_READ` field without a normalizer, or vice
versa).

## Consumed by

Stage 10.6 (Mongoose Persistence Convergence) compiles these contracts into
actual Mongoose schema field declarations. See
`C:\Users\PC\.claude\plans\first-read-my-prd-prancy-crab.md` for the full
two-stage plan.
