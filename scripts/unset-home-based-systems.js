require("dotenv").config();
const { MongoClient } = require("mongodb");
const { databaseName } = require("../config/databaseName");

const NAMES = ["IELTS", "Pearson PTE", "GRE", "TOEFL"];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set.");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry");
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const courses = client.db(databaseName()).collection("courses");

    for (const name of NAMES) {
      const filter = {
        name: { $regex: `^${escapeRegex(name.trim())}$`, $options: "i" },
        homeBasedSystems: { $exists: true },
      };
      const matches = await courses.countDocuments(filter);
      if (matches === 0) {
        console.log(`  –  ${JSON.stringify(name)}: no course with the field set — nothing to undo.`);
        continue;
      }
      if (dry) {
        console.log(`  [dry] would unset homeBasedSystems on ${matches} course(s) matching ${JSON.stringify(name)}`);
        continue;
      }
      const res = await courses.updateMany(filter, { $unset: { homeBasedSystems: "" } });
      console.log(`  ✅ ${JSON.stringify(name)}: matched ${res.matchedCount}, modified ${res.modifiedCount} (field removed)`);
    }

    console.log(dry ? "\nDry run complete (no changes)." : "\nDone.");
  } catch (err) {
    console.error("Rollback failed:", err);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
