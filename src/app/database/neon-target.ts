// Classifies a PostgreSQL URL without returning credentials.
// A Neon host proves the provider only. It does not prove non-production.

export interface DatabaseTargetClassification {
  provider: "neon" | "other";
  database: string;
  pooled: boolean;
  hostSuffix: string;
  environmentClassification: "unproven";
}

export function classifyDatabaseUrl(raw: string): DatabaseTargetClassification {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("NEON_DB_URL is not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("NEON_DB_URL is not a PostgreSQL URL");
  }
  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database === "") {
    throw new Error("NEON_DB_URL has no database name");
  }
  const provider = host === "neon.tech" || host.endsWith(".neon.tech") ? "neon" : "other";
  const pooled = host.includes("-pooler") || host.startsWith("pooler.");
  const labels = host.split(".");
  const hostSuffix = labels.length >= 2 ? labels.slice(-2).join(".") : host;
  return {
    provider,
    database,
    pooled,
    hostSuffix,
    environmentClassification: "unproven",
  };
}

export function normalizedEndpointId(raw: string): string {
  const url = new URL(raw);
  const endpoint = url.hostname.toLowerCase().split(".")[0] ?? "";
  return endpoint.replace(/-pooler$/, "");
}
