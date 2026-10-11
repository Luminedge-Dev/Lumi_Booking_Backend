// Stage 17 source selection. Validates policy and mocked connection facts.
// It does not open a MongoDB client and it does not load an application env file.

import { SNAPSHOT_DB, assertLocalReader, assertReadOnlyActions, parseDirectMongoUri, type ReaderIdentity } from "./privilege";

export type SourcePolicyName = "LOCAL_SNAPSHOT" | "FUTURE_FRESH_SOURCE";

export interface ObservedSource {
  host: string;
  port: string;
  username: string;
  databaseName: string;
  authenticatedUsers: Array<{ user: string; db: string }>;
  actions: string[];
}

export interface FreshSourceProfile {
  host: string;
  port: string;
  databaseName: string;
  username: string;
}

export interface SourceAuthorization {
  policy: SourcePolicyName;
  databaseName: string;
  host: string;
  port: string;
  username: string;
}

function requiredUri(env: Readonly<Record<string, string | undefined>>, key: "STAGE17_LOCAL_MONGODB_URI" | "STAGE17_SOURCE_MONGODB_URI"): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function assertAuthDatabase(pathname: string): void {
  if (pathname !== "/admin") throw new Error("URI path is not the admin authentication database");
}

export function selectSourcePolicy(input: {
  policy: SourcePolicyName;
  env: Readonly<Record<string, string | undefined>>;
  observed: ObservedSource;
  fresh?: FreshSourceProfile;
}): SourceAuthorization {
  if (input.policy === "LOCAL_SNAPSHOT") {
    const parsed = parseDirectMongoUri(requiredUri(input.env, "STAGE17_LOCAL_MONGODB_URI"));
    assertAuthDatabase(parsed.pathname);
    const identity: ReaderIdentity = {
      host: input.observed.host,
      port: input.observed.port,
      username: input.observed.username,
      databaseName: input.observed.databaseName,
      authenticatedUsers: input.observed.authenticatedUsers,
      actions: input.observed.actions,
    };
    assertLocalReader(identity);
    if (parsed.host !== identity.host || parsed.port !== identity.port || parsed.username !== identity.username) {
      throw new Error("local snapshot connection does not match the observed endpoint");
    }
    return { policy: "LOCAL_SNAPSHOT", databaseName: SNAPSHOT_DB, host: identity.host, port: identity.port, username: identity.username };
  }

  if (!input.fresh) throw new Error("a future fresh source requires an explicit host and database profile");
  const parsed = parseDirectMongoUri(requiredUri(input.env, "STAGE17_SOURCE_MONGODB_URI"));
  assertAuthDatabase(parsed.pathname);
  const profile = input.fresh;
  if (profile.databaseName.length === 0 || /[/\s]/.test(profile.databaseName)) throw new Error("fresh source database name is invalid");
  if (profile.databaseName === SNAPSHOT_DB) throw new Error("a fresh source cannot reuse the local snapshot database name");
  if (parsed.host !== profile.host || parsed.port !== profile.port || parsed.username !== profile.username) {
    throw new Error("fresh source connection string does not match the authorized profile");
  }
  if (
    input.observed.host !== profile.host ||
    input.observed.port !== profile.port ||
    input.observed.username !== profile.username ||
    input.observed.databaseName !== profile.databaseName
  ) {
    throw new Error("observed fresh source does not match the authorized profile");
  }
  if (input.observed.authenticatedUsers.length !== 1) throw new Error("connection does not have exactly one authenticated user");
  const actor = input.observed.authenticatedUsers[0]!;
  if (actor.user !== profile.username || actor.db.length === 0) throw new Error("authenticated user does not match the authorized profile");
  assertReadOnlyActions(input.observed.actions);
  return {
    policy: "FUTURE_FRESH_SOURCE",
    databaseName: profile.databaseName,
    host: profile.host,
    port: profile.port,
    username: profile.username,
  };
}
