// Proves legacy dependencies flow through src/app/compat/** only, regardless of
// whether the reference is a CommonJS require()/createRequire() or a static ES
// import — checking only require() would miss a violation like
// `import bookingRoutes from "../../routes/booking.routes"` appearing outside
// compat/, since static import is now the preferred mechanism everywhere else.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve(__dirname, "..", "..", "src");
const COMPAT_DIR = path.join(SRC_DIR, "app", "compat");

// Legacy-module path fragments that may only be referenced from inside compat/.
// All markers are anchored to dot-dot-only paths ("../middleware/...",
// "../../../routes/...", "../../../app.js", "../index.js", ...) so they only
// match a climb up to the backend-root legacy files — never a local
// subdirectory of this tree such as "./app/middleware/..." (Stage 5's own
// src/app/middleware/) or "./app/database/...". A plain "/middleware/"
// substring check would have been a false positive the moment Stage 5
// introduced its own (non-legacy) src/app/middleware/ directory.
const LEGACY_PATH_MARKERS: Array<string | RegExp> = [
  /['"]\.\.(?:\/\.\.)*\/routes\//,
  /['"]\.\.(?:\/\.\.)*\/middleware\//,
  /['"]\.\.(?:\/\.\.)*\/jobs\//,
  /['"]\.\.(?:\/\.\.)*\/app(\.js)?['"]/,
  /['"]\.\.(?:\/\.\.)*\/index(\.js)?['"]/,
];

// Build-phase result: no compat file needed a require()/createRequire() fallback —
// every legacy module interoperated correctly via static import. If a future
// change introduces one, add its exact file + reason here and it becomes the
// only allowed match.
const DOCUMENTED_REQUIRE_EXCEPTIONS: string[] = [];

function listTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function referencesLegacyModule(line: string): boolean {
  return LEGACY_PATH_MARKERS.some((marker) =>
    typeof marker === "string" ? line.includes(marker) : marker.test(line)
  );
}

// Strips comments before scanning so explanatory prose that merely mentions
// "require(" or a legacy path (e.g. "No require() exception is needed here")
// isn't mistaken for actual code.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

describe("legacy compatibility boundary (architecture)", () => {
  const allFiles = listTsFiles(SRC_DIR);
  const outsideCompat = allFiles.filter((f) => !f.startsWith(COMPAT_DIR + path.sep));
  const insideCompat = allFiles.filter((f) => f.startsWith(COMPAT_DIR + path.sep));

  it("no file outside src/app/compat/ references legacy routes/middleware/jobs/app.js/index.js, via require() or static import", () => {
    const violations: string[] = [];
    for (const file of outsideCompat) {
      const content = stripComments(fs.readFileSync(file, "utf8"));
      for (const line of content.split("\n")) {
        const isImportOrRequire = /\brequire\(/.test(line) || /\bimport\b.*\bfrom\b/.test(line) || /\bcreateRequire\(/.test(line);
        if (isImportOrRequire && referencesLegacyModule(line)) {
          violations.push(`${path.relative(SRC_DIR, file)}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(violations, [], `Legacy references found outside compat/:\n${violations.join("\n")}`);
  });

  it("any require()/createRequire() inside src/app/compat/ is a pre-documented exception", () => {
    const found: string[] = [];
    for (const file of insideCompat) {
      const content = stripComments(fs.readFileSync(file, "utf8"));
      if (/\brequire\(/.test(content) || /\bcreateRequire\(/.test(content)) {
        found.push(path.relative(SRC_DIR, file));
      }
    }
    assert.deepEqual(
      found,
      DOCUMENTED_REQUIRE_EXCEPTIONS,
      `Undocumented require()/createRequire() usage in compat/: ${found.join(", ")}`
    );
  });

  it("legacy-middleware.ts no longer references middleware/rateLimit.js (rate limiting is now native TypeScript)", () => {
    const legacyMiddlewarePath = path.join(COMPAT_DIR, "legacy-middleware.ts");
    const content = stripComments(fs.readFileSync(legacyMiddlewarePath, "utf8"));
    assert.doesNotMatch(
      content,
      /middleware\/rateLimit/,
      "legacy-middleware.ts should no longer import middleware/rateLimit.js after the Stage 5 rate-limit migration"
    );
    assert.match(
      content,
      /middleware\/auth/,
      "middleware/auth.js should remain the one documented legacy middleware reference (auth migration is a later stage)"
    );
  });

  it("legacy-routes.ts no longer mounts routes/auth.routes.js (Stage 7: native Auth replaces it in the TS candidate)", () => {
    const legacyRoutesPath = path.join(COMPAT_DIR, "legacy-routes.ts");
    const content = stripComments(fs.readFileSync(legacyRoutesPath, "utf8"));
    assert.doesNotMatch(
      content,
      /routes\/auth\.routes/,
      "legacy-routes.ts should no longer import/mount routes/auth.routes.js after the Stage 7 Auth migration"
    );
  });

  it("legacy-routes.ts still mounts the FULL, unedited routes/user.routes.js and routes/schedule.routes.js (Stage 8 shadows by mount order, not by editing these files)", () => {
    const legacyRoutesPath = path.join(COMPAT_DIR, "legacy-routes.ts");
    const content = stripComments(fs.readFileSync(legacyRoutesPath, "utf8"));
    assert.match(content, /routes\/user\.routes/, "legacy-routes.ts must still import the full routes/user.routes.js");
    assert.match(content, /routes\/schedule\.routes/, "legacy-routes.ts must still import the full routes/schedule.routes.js");
    assert.match(
      content,
      /mountLegacyUserAndMidRoutes/,
      "legacy-routes.ts must export the Stage 8 split mount function for user/feedback/stats"
    );
    assert.match(
      content,
      /mountLegacyScheduleRoutes/,
      "legacy-routes.ts must export the Stage 8 split mount function for schedule"
    );
  });
});

describe("Stage 7 Auth module boundary (architecture)", () => {
  const AUTH_MODULE_DIR = path.join(SRC_DIR, "app", "modules", "auth");
  const authModuleFiles = listTsFiles(AUTH_MODULE_DIR);
  const REPOSITORY_FILE = path.join(AUTH_MODULE_DIR, "auth.repository.ts");

  // Matches the collection verbs auth.repository.ts itself legitimately uses
  // (findOne/insertOne/updateOne) plus a couple of other common driver verbs,
  // called on any receiver -- a generic shape check, not tied to a specific
  // variable name, so it still catches a hypothetical future violation.
  const MONGO_VERB_CALL = /\.(findOne|insertOne|updateOne|updateMany|deleteOne|deleteMany|find)\s*\(/;

  it("no file in the Auth module performs direct MongoDB collection access outside auth.repository.ts", () => {
    const violations: string[] = [];
    for (const file of authModuleFiles) {
      if (file === REPOSITORY_FILE) continue;
      const content = stripComments(fs.readFileSync(file, "utf8"));
      for (const line of content.split("\n")) {
        if (MONGO_VERB_CALL.test(line)) {
          violations.push(`${path.relative(SRC_DIR, file)}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(violations, [], `Direct Mongo access found outside auth.repository.ts:\n${violations.join("\n")}`);
  });

  it("no file in the Auth module reads process.env directly (config flows through env.ts -> server.ts -> app.ts -> auth.module.ts)", () => {
    const violations: string[] = [];
    for (const file of authModuleFiles) {
      const content = stripComments(fs.readFileSync(file, "utf8"));
      if (/process\.env/.test(content)) {
        violations.push(path.relative(SRC_DIR, file));
      }
    }
    assert.deepEqual(violations, [], `process.env read directly inside the Auth module: ${violations.join(", ")}`);
  });

  it("the Auth module exists with the required module-first files", () => {
    const required = [
      "auth.module.ts",
      "auth.route.ts",
      "auth.controller.ts",
      "auth.service.ts",
      "auth.repository.ts",
      "auth.middleware.ts",
      "auth.validation.ts",
      "auth.types.ts",
    ];
    for (const name of required) {
      assert.ok(fs.existsSync(path.join(AUTH_MODULE_DIR, name)), `missing required Auth module file: ${name}`);
    }
  });
});

describe("Stage 8 User/Course module boundary (architecture)", () => {
  const USER_MODULE_DIR = path.join(SRC_DIR, "app", "modules", "user");
  const COURSE_MODULE_DIR = path.join(SRC_DIR, "app", "modules", "course");
  const userModuleFiles = listTsFiles(USER_MODULE_DIR);
  const courseModuleFiles = listTsFiles(COURSE_MODULE_DIR);
  const USER_REPOSITORY_FILE = path.join(USER_MODULE_DIR, "user.repository.ts");
  const COURSE_REPOSITORY_FILE = path.join(COURSE_MODULE_DIR, "course.repository.ts");

  const MONGO_VERB_CALL = /\.(findOne|insertOne|updateOne|updateMany|deleteOne|deleteMany|find|countDocuments)\s*\(/;

  function assertNoDirectMongoOutsideRepository(files: string[], repositoryFile: string, moduleName: string) {
    const violations: string[] = [];
    for (const file of files) {
      if (file === repositoryFile) continue;
      const content = stripComments(fs.readFileSync(file, "utf8"));
      for (const line of content.split("\n")) {
        if (MONGO_VERB_CALL.test(line)) {
          violations.push(`${path.relative(SRC_DIR, file)}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(violations, [], `Direct Mongo access found outside ${moduleName}'s repository:\n${violations.join("\n")}`);
  }

  function assertNoProcessEnv(files: string[], moduleName: string) {
    const violations: string[] = [];
    for (const file of files) {
      const content = stripComments(fs.readFileSync(file, "utf8"));
      if (/process\.env/.test(content)) {
        violations.push(path.relative(SRC_DIR, file));
      }
    }
    assert.deepEqual(violations, [], `process.env read directly inside the ${moduleName} module: ${violations.join(", ")}`);
  }

  it("no file in the User module performs direct MongoDB collection access outside user.repository.ts", () => {
    assertNoDirectMongoOutsideRepository(userModuleFiles, USER_REPOSITORY_FILE, "User");
  });

  it("no file in the Course module performs direct MongoDB collection access outside course.repository.ts", () => {
    assertNoDirectMongoOutsideRepository(courseModuleFiles, COURSE_REPOSITORY_FILE, "Course");
  });

  it("no file in the User module reads process.env directly", () => {
    assertNoProcessEnv(userModuleFiles, "User");
  });

  it("no file in the Course module reads process.env directly", () => {
    assertNoProcessEnv(courseModuleFiles, "Course");
  });

  it("the User module exists with the required module-first files", () => {
    const required = [
      "user.module.ts",
      "user.route.ts",
      "user.controller.ts",
      "user.service.ts",
      "user.repository.ts",
      "user.authorization.ts",
      "user.mapper.ts",
      "user.validation.ts",
      "user.types.ts",
    ];
    for (const name of required) {
      assert.ok(fs.existsSync(path.join(USER_MODULE_DIR, name)), `missing required User module file: ${name}`);
    }
  });

  it("the Course module exists with the required module-first files", () => {
    const required = [
      "course.module.ts",
      "course.route.ts",
      "course.controller.ts",
      "course.service.ts",
      "course.repository.ts",
      "course.mapper.ts",
      "course.types.ts",
    ];
    for (const name of required) {
      assert.ok(fs.existsSync(path.join(COURSE_MODULE_DIR, name)), `missing required Course module file: ${name}`);
    }
  });

  it("user.authorization.ts has no Express/HTTP coupling (pure predicates only, per the Stage 8 plan's architecture correction)", () => {
    const content = stripComments(fs.readFileSync(path.join(USER_MODULE_DIR, "user.authorization.ts"), "utf8"));
    assert.doesNotMatch(content, /from ["']express["']/, "user.authorization.ts must not import express");
    assert.doesNotMatch(content, /\bres\.status\s*\(/, "user.authorization.ts must not write HTTP responses itself");
  });

  it("the mandatory route-collision guard (passThroughNonObjectId) is registered before verifyToken on GET /user/:userId", () => {
    const content = stripComments(fs.readFileSync(path.join(USER_MODULE_DIR, "user.route.ts"), "utf8"));
    const match = content.match(/router\.get\(\s*"\/user\/:userId"[\s\S]*?\);/);
    assert.ok(match, "expected to find the GET /user/:userId route registration");
    const registration = match![0];
    const guardIndex = registration.indexOf("passThroughNonObjectId");
    const verifyTokenIndex = registration.indexOf("verifyToken");
    assert.ok(guardIndex !== -1, "passThroughNonObjectId must be referenced in the /user/:userId route");
    assert.ok(verifyTokenIndex !== -1, "verifyToken must be referenced in the /user/:userId route");
    assert.ok(
      guardIndex < verifyTokenIndex,
      "passThroughNonObjectId must be registered BEFORE verifyToken on GET /user/:userId (route-collision guard ordering requirement)"
    );
  });
});

describe("Stage 9 Schedule module boundary (architecture)", () => {
  const SCHEDULE_MODULE_DIR = path.join(SRC_DIR, "app", "modules", "schedule");
  const scheduleModuleFiles = listTsFiles(SCHEDULE_MODULE_DIR);
  const SCHEDULE_REPOSITORY_FILE = path.join(SCHEDULE_MODULE_DIR, "schedule.repository.ts");

  const MONGO_VERB_CALL = /\.(findOne|insertOne|updateOne|updateMany|deleteOne|deleteMany|find|countDocuments|aggregate)\s*\(/;

  it("no file in the Schedule module performs direct MongoDB collection access outside schedule.repository.ts", () => {
    const violations: string[] = [];
    for (const file of scheduleModuleFiles) {
      if (file === SCHEDULE_REPOSITORY_FILE) continue;
      const content = stripComments(fs.readFileSync(file, "utf8"));
      for (const line of content.split("\n")) {
        if (MONGO_VERB_CALL.test(line)) {
          violations.push(`${path.relative(SRC_DIR, file)}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(violations, [], `Direct Mongo access found outside schedule.repository.ts:\n${violations.join("\n")}`);
  });

  it("no file in the Schedule module reads process.env directly", () => {
    const violations: string[] = [];
    for (const file of scheduleModuleFiles) {
      const content = stripComments(fs.readFileSync(file, "utf8"));
      if (/process\.env/.test(content)) {
        violations.push(path.relative(SRC_DIR, file));
      }
    }
    assert.deepEqual(violations, [], `process.env read directly inside the Schedule module: ${violations.join(", ")}`);
  });

  it("the Schedule module exists with the required module-first files", () => {
    const required = [
      "schedule.module.ts",
      "schedule.route.ts",
      "schedule.controller.ts",
      "schedule.service.ts",
      "schedule.repository.ts",
      "schedule.mapper.ts",
      "schedule.validation.ts",
      "schedule.types.ts",
    ];
    for (const name of required) {
      assert.ok(fs.existsSync(path.join(SCHEDULE_MODULE_DIR, name)), `missing required Schedule module file: ${name}`);
    }
  });

  it("no file in the Schedule module depends on a booking collection (delete stays a Schedule-only hard delete this stage)", () => {
    const violations: string[] = [];
    for (const file of scheduleModuleFiles) {
      const content = stripComments(fs.readFileSync(file, "utf8"));
      if (/bookingMockCollection|bookingCollection/.test(content)) {
        violations.push(path.relative(SRC_DIR, file));
      }
    }
    assert.deepEqual(violations, [], `Unexpected booking-collection dependency inside the Schedule module: ${violations.join(", ")}`);
  });

  it("no file in the Schedule module imports routes/schedule.routes.js (coexists only via the compat mount-order boundary)", () => {
    const violations: string[] = [];
    for (const file of scheduleModuleFiles) {
      const content = stripComments(fs.readFileSync(file, "utf8"));
      if (/routes\/schedule\.routes/.test(content)) {
        violations.push(path.relative(SRC_DIR, file));
      }
    }
    assert.deepEqual(violations, [], `Unexpected routes/schedule.routes.js reference inside the Schedule module: ${violations.join(", ")}`);
  });

  it("the mandatory route-order guard: GET /schedule/course/:courseId is registered before GET /schedule/:date/:courseId", () => {
    const content = stripComments(fs.readFileSync(path.join(SCHEDULE_MODULE_DIR, "schedule.route.ts"), "utf8"));
    const monthlyIndex = content.indexOf('"/schedule/course/:courseId"');
    const dailyIndex = content.indexOf('"/schedule/:date/:courseId"');
    assert.ok(monthlyIndex !== -1, "expected to find the GET /schedule/course/:courseId route registration");
    assert.ok(dailyIndex !== -1, "expected to find the GET /schedule/:date/:courseId route registration");
    assert.ok(
      monthlyIndex < dailyIndex,
      "/schedule/course/:courseId must be registered BEFORE /schedule/:date/:courseId (route-order guard requirement)"
    );
  });
});
