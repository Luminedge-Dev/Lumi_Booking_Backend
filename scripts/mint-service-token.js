require("dotenv").config();
const { MongoClient } = require("mongodb");
const { databaseName } = require("../config/databaseName");
const jwt = require("jsonwebtoken");

const STAFF_ROLES = ["admin", "bdm", "teacher"];

(async () => {
  const email = process.argv[2];
  const expiresIn = process.argv[3] || "365d";

  if (!email) {
    console.error("Usage: node scripts/mint-service-token.js <staff-email> [expiresIn]");
    process.exit(1);
  }
  if (!process.env.MONGODB_URI || !process.env.JWT_SECRET) {
    console.error("MONGODB_URI and JWT_SECRET must be set (run against the target environment's .env).");
    process.exit(1);
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const usersCollection = client.db(databaseName()).collection("users");

    const user = await usersCollection.findOne({ email: email.toLowerCase() });
    if (!user) {
      console.error(`No user found with email ${email}`);
      process.exit(1);
    }
    if (!STAFF_ROLES.includes(user.role)) {
      console.error(`User ${email} has role "${user.role}" — must be one of ${STAFF_ROLES.join(", ")}.`);
      process.exit(1);
    }

    const token = jwt.sign(
      { email: user.email, userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn }
    );

    console.log(token);
  } finally {
    await client.close();
  }
})();
