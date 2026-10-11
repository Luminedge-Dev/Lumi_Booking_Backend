require("dotenv").config();
const { MongoClient } = require("mongodb");
const { databaseName } = require("../config/databaseName");

const RULES = [
  { name: "IELTS", homeBasedSystems: ["Computer-Based"] },
  { name: "Pearson PTE", homeBasedSystems: ["Computer-Based"] },
  { name: "GRE", homeBasedSystems: [] },
  { name: "TOEFL", homeBasedSystems: [] },
];

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

    for (const rule of RULES) {
      const filter = {
        name: { $regex: `^${escapeRegex(rule.name.trim())}$`, $options: "i" },
      };
      const matches = await courses.countDocuments(filter);
      if (matches === 0) {
        console.warn(`  ⚠️  No course matched name ~= ${JSON.stringify(rule.name)} — skipped.`);
        continue;
      }
      if (dry) {
        console.log(
          `  [dry] would set homeBasedSystems=${JSON.stringify(rule.homeBasedSystems)} on ${matches} course(s) matching ${JSON.stringify(rule.name)}`
        );
        continue;
      }
      const res = await courses.updateMany(filter, {
        $set: { homeBasedSystems: rule.homeBasedSystems },
      });
      console.log(
        `  ✅ ${JSON.stringify(rule.name)}: matched ${res.matchedCount}, modified ${res.modifiedCount} -> ${JSON.stringify(rule.homeBasedSystems)}`
      );
    }

    console.log(dry ? "\nDry run complete (no changes)." : "\nDone.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
