# Module Convention (vertical modules)

Implemented modules: `auth/`, `user/`, `course/`, `schedule/`.
Planned modules: `booking/`, `entitlement/`, `feedback/`, `trf/`,
`analytics/`, `notifications/`.

## Shape

A migrated business module will normally look like:

```text
modules/booking/
├── booking.module.ts
├── booking.route.ts
├── booking.controller.ts
├── booking.service.ts
├── booking.repository.ts
├── booking.validation.ts
├── booking.types.ts
├── booking.constant.ts      # only if needed
└── booking.utils.ts         # only if needed
```

Same shape applies to every other module: `auth/`, `user/`, `course/`, `schedule/`,
`entitlement/`, `feedback/`, `trf/`, `analytics/`, `notification/`.

## Responsibility boundaries

**Route** — HTTP method/path, middleware, validation, controller call. No DB
queries, no business logic.

**Controller** — HTTP input, verified request context, service call, HTTP response.
No Mongo queries.

**Service** — business rules, authorization policy, transaction orchestration,
domain decisions. Framework-agnostic (no `req`/`res`).

**Repository** — persistence implementation behind the module boundary:
filters, projections, updates, aggregations. No authorization/business decisions.

**Validation** — module-owned request schemas (params/query/body).

**Types** — domain/API types for this module.

**Utils** — module-specific reusable helpers only. Do not put cross-module technical
concerns here — those belong in `../shared/`.

## Do not

- Create a generic mega-query helper (`findById(collectionName)`,
  `updateAnyCollection(...)`) that bypasses a module's own repository.
- Reach into another module's repository/service directly — go through its exported
  module boundary once modules exist.
- Add empty ceremonial module folders ahead of their actual migration stage.
