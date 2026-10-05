// Stage 10 architecture/safety guard. Static/structural checks only -- runs
// under the FAST pnpm test:architecture suite (plain .test.ts), never
// pnpm test:transaction, since it never touches a real Mongo instance.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(ROOT, "src");
const REPLICA_SET_HELPER = path.join(ROOT, "tests", "transactions", "helpers", "replica-set.ts");
const TRANSACTIONS_DIR = path.join(ROOT, "tests", "transactions");

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

describe("Stage 10 transaction-test-foundation boundary (architecture)", () => {
  it("package.json declares a test:transaction script targeting only the one Stage 10 file", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts["test:transaction"];
    assert.ok(script, "expected a test:transaction script");
    assert.ok(
      script.includes("tests/transactions/transaction-foundation.transaction.ts"),
      "test:transaction must target the explicit single file, not a glob"
    );
    assert.ok(!script.includes("*"), "test:transaction must not use a glob pattern");
  });

  it("mongodb-memory-server-core is a devDependency, never a production dependency", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.ok(pkg.devDependencies?.["mongodb-memory-server-core"], "expected mongodb-memory-server-core under devDependencies");
    assert.ok(!pkg.dependencies?.["mongodb-memory-server-core"], "mongodb-memory-server-core must never be a production dependency");
  });

  it("no file under src/** imports mongodb-memory-server-core", () => {
    const offenders = listFilesRecursive(SRC_DIR)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
      .filter((f) => fs.readFileSync(f, "utf8").includes("mongodb-memory-server"));
    assert.deepEqual(offenders, [], "no src/** file may reference mongodb-memory-server-core");
  });

  it("the replica-set helper never reads MONGODB_URI or DEST_MONGODB_URI", () => {
    const source = fs.readFileSync(REPLICA_SET_HELPER, "utf8");
    // Checks actual process.env property access, not a bare substring --
    // this file's own doc comments legitimately mention these env var names
    // by name to explain what it deliberately does NOT read.
    assert.ok(!source.includes("process.env.MONGODB_URI"), "replica-set.ts must never read process.env.MONGODB_URI");
    assert.ok(!source.includes("process.env.DEST_MONGODB_URI"), "replica-set.ts must never read process.env.DEST_MONGODB_URI");
    assert.ok(!source.includes('process.env["MONGODB_URI"]'), "replica-set.ts must never read process.env[\"MONGODB_URI\"]");
  });

  it("the replica-set helper pins an explicit MongoDB binary version", () => {
    const source = fs.readFileSync(REPLICA_SET_HELPER, "utf8");
    assert.ok(/binary:\s*{\s*version:/.test(source), "MongoMemoryReplSet.create() must pass an explicit binary.version");
  });

  it("every file under tests/transactions/ (excluding helpers/) uses the *.transaction.ts suffix, never *.test.ts", () => {
    const files = listFilesRecursive(TRANSACTIONS_DIR).filter((f) => !f.includes(`${path.sep}helpers${path.sep}`));
    for (const file of files) {
      assert.ok(!file.endsWith(".test.ts"), `${file} must not use the .test.ts suffix (it would be picked up by the fast suite)`);
      if (file.endsWith(".ts")) {
        assert.ok(file.endsWith(".transaction.ts"), `${file} must use the .transaction.ts suffix`);
      }
    }
  });
});
