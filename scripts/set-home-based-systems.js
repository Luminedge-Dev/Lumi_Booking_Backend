// One-off migration: set the per-course Home-eligible test systems.
//
// Semantics enforced in routes/booking.routes.js:
//   - field absent            => Home allowed for any system (default)
//   - present, system listed  => allowed
//   - present, [] or missing  => blocked (empty list blocks every system)
//
// IMPORTANT: run scripts/inspect-courses.js FIRST and confirm the real course
// names + system spelling. Adjust RULES below to match your data exactly, then
// run:  node scripts/set-home-based-systems.js
// Dry run (no writes):  node scripts/set-home-based-systems.js --dry
require("dotenv").config();
const { MongoClient } = require("mongodb");

// Course name (matched case-insensitively, trimmed, exact) -> allowed Home systems.
// Names verified against the live `courses` collection via inspect-courses.js.
// The PTE course doc is named "Pearson PTE" (not "PTE"); bookings post `name`
// as one of ["GRE","IELTS","Pearson PTE","TOEFL"], which the backend looks up
// against `courses.name`. The unused "IELTS Computer Based" doc is intentionally
// left untouched — no booking references it, so enforcement never reaches it.
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
    const courses = client.db("luminedge").collection("courses");

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
