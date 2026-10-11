import { MongoClient } from "mongodb";
import type { SourceEntity } from "../stage14/common";
import { createReadOnlyCollection, type ReadOnlySource } from "../stage14/extract/source";
import { SNAPSHOT_DB, assertLocalReader, parseLocalMongoUri, type ReaderIdentity } from "./privilege";

/** Rejects a non-local or non-reader URI before a client is constructed. */
export function assertLocalUriShape(uri: string): { host: string; port: string; username: string; pathname: string } {
  const parsed = parseLocalMongoUri(uri);
  if (parsed.pathname !== "/admin") throw new Error("URI path is not the admin authentication database");
  if (parsed.host !== "127.0.0.1" || parsed.port !== "27017") throw new Error("endpoint is not the local MongoDB server");
  if (parsed.username !== "reader") throw new Error("authenticated username is not reader");
  return parsed;
}

function readActions(privileges: Array<{ actions?: string[] }> | undefined): string[] {
  const actions = new Set<string>();
  for (const privilege of privileges ?? []) {
    for (const action of privilege.actions ?? []) actions.add(action);
  }
  return [...actions].sort();
}

/** Proves the process is the local reader on this client, then returns the
 * Stage 14 read-only wrapper for that same client. */
export async function openVerifiedSnapshot(uri: string): Promise<{ source: ReadOnlySource; identity: ReaderIdentity }> {
  const parsed = assertLocalUriShape(uri);
  const client = new MongoClient(uri, {
    appName: "luminedge-stage17-local-readonly",
    retryWrites: false,
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    socketTimeoutMS: 180_000,
    maxPoolSize: 1,
  });
  try {
    await client.connect();
    const status = (await client.db("admin").command({ connectionStatus: 1, showPrivileges: true })) as {
      authInfo?: {
        authenticatedUsers?: Array<{ user?: string; db?: string }>;
        authenticatedUserPrivileges?: Array<{ actions?: string[] }>;
      };
    };
    const users = (status.authInfo?.authenticatedUsers ?? []).map((user) => ({
      user: String(user.user ?? ""),
      db: String(user.db ?? ""),
    }));
    const snapshot = client.db(SNAPSHOT_DB);
    await snapshot.command({ ping: 1 });
    const identity: ReaderIdentity = {
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      authenticatedUsers: users,
      actions: readActions(status.authInfo?.authenticatedUserPrivileges),
      databaseName: snapshot.databaseName,
    };
    assertLocalReader(identity);
    const source: ReadOnlySource = {
      collection: (name: SourceEntity) => createReadOnlyCollection(name, snapshot.collection(name) as never),
      close: () => client.close(),
    };
    return { source, identity };
  } catch (error) {
    await client.close();
    throw error;
  }
}
