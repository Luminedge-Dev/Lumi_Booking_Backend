function databaseName() {
  const configured = typeof process.env.MONGODB_DB_NAME === "string" ? process.env.MONGODB_DB_NAME.trim() : "";
  return configured || "luminedge";
}

module.exports = { databaseName };
