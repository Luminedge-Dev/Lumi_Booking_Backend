// Stage 12.5 Pass A.2 shared-foundation ownership guards. Static,
// side-effect-free: reads source files and the built rate-limit policy,
// never Mongo, never .env.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import {
  authRateLimiter,
  globalRateLimiter,
  AUTH_RATE_LIMIT_PATHS,
} from "../../src/app/middleware/rate-limit";

const BACKEND_DIR = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(BACKEND_DIR, "src");

function readFromSrc(relative: string): string {
  return readFileSync(path.join(SRC_DIR, relative), "utf8");
}

describe("Express request typing is centralized (architecture)", () => {
  it("shared/types/express.d.ts declares Request.user exactly once", () => {
    assert.ok(existsSync(path.join(SRC_DIR, "app", "shared", "types", "express.d.ts")));
    const declaration = readFromSrc(path.join("app", "shared", "types", "express.d.ts"));
    assert.match(declaration, /interface Request \{\s*user\?: AuthActor;\s*\}/);
    assert.ok(declaration.includes("modules/auth/auth.types"), "must reuse the Auth-owned actor type");
    assert.ok(!/UserRole|UserStatus|prisma/i.test(declaration), "no generated-Prisma enums in request typing");
  });

  it("auth.middleware.ts no longer declares globals itself", () => {
    const middleware = readFromSrc(path.join("app", "modules", "auth", "auth.middleware.ts"));
    assert.ok(!middleware.includes("declare global"), "Request typing must live in shared/types only");
  });
});

describe("deferred-stack ban (architecture)", () => {
  it("Prisma stays inside the database layer; Better Auth runtime, QueryBuilder, and Lucia stay absent", () => {
    // Stage 15: Prisma may live only in the database layer, the composition
    // file that constructs the Prisma repositories, and the four migrated
    // modules' repository files. Never in routes/controllers/services.
    const prismaOwners = new Set([
      path.normalize("app/database/prisma.ts"),
      path.normalize("app/database/transaction.ts"),
      path.normalize("app/database/persistence-error.ts"),
      path.normalize("app/runtime/core-repositories.ts"),
      path.normalize("app/modules/auth/auth.repository.ts"),
      path.normalize("app/modules/user/user.repository.ts"),
      path.normalize("app/modules/course/course.repository.ts"),
      path.normalize("app/modules/schedule/schedule.repository.ts"),
    ]);
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readDir(dir)) {
        if (!entry.endsWith(".ts")) continue;
        if (entry.includes(`${path.sep}generated${path.sep}prisma${path.sep}`)) continue;
        const content = readFileSync(entry, "utf8");
        const code = content
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .map((line) => {
            const idx = line.indexOf("//");
            return idx === -1 ? line : line.slice(0, idx);
          })
          .join("\n");
        const relative = path.normalize(path.relative(SRC_DIR, entry));
        const mentionsPrisma = /prisma|@prisma/i.test(code);
        if (mentionsPrisma && !prismaOwners.has(relative)) {
          offenders.push(relative);
        }
        if (/better-auth|BetterAuth|QueryBuilder|queryHelper|@lucia/i.test(code)) {
          offenders.push(relative);
        }
      }
    };
    visit(SRC_DIR);
    assert.deepEqual(offenders, []);
  });

  it("no dead catchAsync helper was created", () => {
    assert.ok(!existsSync(path.join(SRC_DIR, "app", "shared", "helpers", "catch-async.ts")));
  });

  it("no global response wrapper or pagination helper was created", () => {
    assert.ok(!existsSync(path.join(SRC_DIR, "app", "shared", "helpers", "send-response.ts")));
    assert.ok(!existsSync(path.join(SRC_DIR, "app", "shared", "helpers", "pagination.ts")));
  });
});

describe("single API composition point (architecture)", () => {
  it("app.ts is the only file that mounts the /api/v1 prefix", () => {
    const offenders: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readDir(dir)) {
        if (entry.endsWith(".ts")) {
          const content = readFileSync(entry, "utf8");
          if (/\.use\(\s*["']\/api\/v1["']/.test(content)) {
            offenders.push(path.relative(SRC_DIR, entry));
          }
        }
      }
    };
    visit(SRC_DIR);
    assert.deepEqual(offenders, [path.join("app.ts")]);
  });

  it("compat mounts carry no prefix of their own", () => {
    const compat = readFromSrc(path.join("app", "compat", "legacy-routes.ts"));
    assert.ok(!compat.includes("/api/v1"), "prefix ownership belongs to app.ts only");
  });
});

describe("locked middleware policy (architecture)", () => {
  it("auth rate-limit paths are unchanged", () => {
    assert.deepEqual([...AUTH_RATE_LIMIT_PATHS], [
      "/api/v1/login",
      "/api/v1/register",
      "/api/v1/auth/forget-password",
      "/api/v1/auth/reset-password",
    ]);
  });

  it("both limiters are middleware functions", () => {
    assert.equal(typeof authRateLimiter, "function");
    assert.equal(typeof globalRateLimiter, "function");
  });
});

function readDir(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readDir(full));
    } else {
      files.push(full);
    }
  }
  return files;
}
