// Stage 10.5 (D-031) architecture/safety guard. Static/structural checks
// only -- proves tools/migration/** is genuinely standalone this stage: not
// imported by the running application, never reaching into legacy/native
// app code itself, and never touching a production Mongo connection string.
// Package/lockfile-unchanged is verified by the final `git diff` gate in
// the Stage 10.5 verification sequence, not here.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(ROOT, "src");
const MIGRATION_DIR = path.join(ROOT, "tools", "migration");

function listFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(full));
    else files.push(full);
  }
  return files;
}

function tsFiles(dir: string): string[] {
  return listFilesRecursive(dir).filter((f) => f.endsWith(".ts"));
}

describe("Stage 10.5 migration-tooling boundary (architecture)", () => {
  it("no file under src/app/** imports from tools/migration/**", () => {
    const offenders = tsFiles(SRC_DIR).filter((f) => {
      const source = fs.readFileSync(f, "utf8");
      return /from\s+["'][^"']*tools\/migration/.test(source) || /require\(\s*["'][^"']*tools\/migration/.test(source);
    });
    assert.deepEqual(offenders, [], "no src/app/** file may import from tools/migration/** this stage");
  });

  it("no file under tools/migration/** imports from src/app/**, routes/**, middleware/**, app.js, or index.js", () => {
    const forbiddenPatterns = [
      /from\s+["'][^"']*\/src\/app\//,
      /from\s+["'][^"']*\.\.\/\.\.\/src\//,
      /from\s+["'][^"']*\/routes\//,
      /from\s+["'][^"']*\/middleware\//,
      /require\(\s*["'][^"']*\/routes\//,
      /require\(\s*["'][^"']*\/middleware\//,
      /require\(\s*["'][^"']*\/app["']\s*\)/,
      /require\(\s*["'][^"']*\/index["']\s*\)/,
    ];
    const offenders = tsFiles(MIGRATION_DIR).filter((f) => {
      const source = fs.readFileSync(f, "utf8");
      return forbiddenPatterns.some((pattern) => pattern.test(source));
    });
    assert.deepEqual(offenders, [], "tools/migration/** must stay standalone -- no import from the running application");
  });

  it("no file under tools/migration/** reads a production Mongo connection-string env var", () => {
    const offenders = tsFiles(MIGRATION_DIR).filter((f) => {
      const source = fs.readFileSync(f, "utf8");
      return (
        source.includes("process.env.MONGODB_URI") ||
        source.includes("process.env.DEST_MONGODB_URI") ||
        source.includes('process.env["MONGODB_URI"]')
      );
    });
    assert.deepEqual(offenders, [], "tools/migration/** must never read a production Mongo connection-string env var");
  });
});
