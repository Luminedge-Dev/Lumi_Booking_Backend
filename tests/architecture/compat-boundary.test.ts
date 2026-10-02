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
});
