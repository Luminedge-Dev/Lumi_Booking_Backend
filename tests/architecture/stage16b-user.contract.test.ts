import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

describe("Stage 16B user admin mutations (architecture)", () => {
  it("Prisma and raw SQL stay in user.repository.ts", () => {
    for (const file of fs.readdirSync(path.join(root, "src/app/modules/user")).filter((f) => f.endsWith(".ts"))) {
      const source = read(`src/app/modules/user/${file}`);
      if (file === "user.repository.ts") {
        assert.match(source, /FOR UPDATE/);
        assert.match(source, /pg_advisory_xact_lock/);
        continue;
      }
      assert.doesNotMatch(source, /\$queryRaw|\$executeRaw|PrismaClient/);
    }
  });

  it("service does not send email itself", () => {
    const service = read("src/app/modules/user/user.service.ts");
    assert.doesNotMatch(service, /emailSender|waitUntil/);
    assert.match(service, /notifier/);
  });

  it("native PUTs use verifyAdmin and sit before GET /user/:userId", () => {
    const routes = read("src/app/modules/user/user.route.ts");
    for (const pathName of [
      "/user/update-multiple/:userId",
      "/user/update-one/:userId",
      "/user/status/:userId",
      "/user/block/:userId",
      "/user/approve-profile-edit/:userId",
    ]) {
      assert.match(routes, new RegExp(pathName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.ok(routes.indexOf("update-multiple") < routes.indexOf('"/user/:userId"'));
    assert.match(routes, /verifyAdmin/);
  });

  it("D9 and P1 refuse without inventing a unique index", () => {
    const repo = read("src/app/modules/user/user.repository.ts");
    assert.match(repo, /ambiguous/);
    assert.match(repo, /email_in_use/);
    assert.doesNotMatch(repo, /@@unique|CREATE UNIQUE/);
    const schema = read("prisma/schema/user.prisma") + read("prisma/schema/auth.prisma");
    assert.doesNotMatch(schema, /email\s+String\s+@unique/);
  });

  it("listing GETs stay off the native User router (B8)", () => {
    const routes = read("src/app/modules/user/user.route.ts");
    assert.doesNotMatch(routes, /\/admin\/users/);
    assert.doesNotMatch(routes, /\/user\/all/);
    assert.match(read("src/app/compat/legacy-routes.ts"), /GET \/admin\/users/);
  });

  it("register and approve share EMAIL_LOCK_SEED", () => {
    const identity = read("src/app/shared/email-identity.ts");
    assert.match(identity, /EMAIL_LOCK_SEED = 15/);
    assert.match(read("src/app/modules/auth/auth.repository.ts"), /EMAIL_LOCK_SEED/);
    assert.match(read("src/app/modules/user/user.repository.ts"), /EMAIL_LOCK_SEED/);
  });
});
