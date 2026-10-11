export const SNAPSHOT_DB = "luminedge_stage17_snapshot_20261008";

export const EXPECTED_COUNTS = {
  users: 9205,
  schedules: 2457,
  courses: 5,
  bookingMock: 21210,
} as const;

export const READ_ACTIONS = [
  "changeStream",
  "collStats",
  "dbHash",
  "dbStats",
  "find",
  "killCursors",
  "listCollections",
  "listDatabases",
  "listIndexes",
  "listSearchIndexes",
  "planCacheRead",
] as const;

const READ_ACTION_SET = new Set<string>(READ_ACTIONS);

export function assertReadOnlyActions(actions: readonly string[]): void {
  if (actions.length === 0) throw new Error("connection reported no privileges");
  for (const action of actions) {
    if (!READ_ACTION_SET.has(action)) throw new Error(`connection has a privilege outside the read-only set: ${action}`);
  }
  if (!actions.includes("find")) throw new Error("connection cannot find documents");
}

export interface ReaderIdentity {
  host: string;
  port: string;
  username: string;
  authenticatedUsers: Array<{ user: string; db: string }>;
  actions: string[];
  databaseName: string;
}

export function parseDirectMongoUri(uri: string): { host: string; port: string; username: string; pathname: string } {
  if (uri.startsWith("mongodb+srv:")) throw new Error("SRV connection strings are refused");
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("the MongoDB connection string could not be parsed");
  }
  if (parsed.protocol !== "mongodb:") throw new Error("only a direct mongodb connection is accepted");
  return {
    host: parsed.hostname,
    port: parsed.port || "27017",
    username: decodeURIComponent(parsed.username),
    pathname: parsed.pathname,
  };
}

export function parseLocalMongoUri(uri: string): { host: string; port: string; username: string; pathname: string } {
  return parseDirectMongoUri(uri);
}

export function assertLocalReader(identity: ReaderIdentity): void {
  if (identity.host !== "127.0.0.1" || identity.port !== "27017") {
    throw new Error("endpoint is not the local MongoDB server");
  }
  if (identity.username !== "reader") throw new Error("authenticated username is not reader");
  if (identity.databaseName !== SNAPSHOT_DB) throw new Error("database name is not the Stage 17 snapshot");
  if (identity.authenticatedUsers.length !== 1) throw new Error("connection does not have exactly one authenticated user");
  const actor = identity.authenticatedUsers[0]!;
  if (actor.user !== "reader" || actor.db !== "admin") throw new Error("connection is not reader on the admin authentication database");
  if (identity.actions.length === 0) throw new Error("connection reported no privileges");
  assertReadOnlyActions(identity.actions);
}
