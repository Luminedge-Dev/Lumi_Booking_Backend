// Pure environment parsers. They never read process.env themselves and never
// include the raw value in an error message.

const SAFE_INTEGER = /^(0|[1-9][0-9]*)$/;

export function getOptionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (value === undefined || value === "") return undefined;
  return value;
}

export function getRequiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = getOptionalEnv(env, key);
  if (value === undefined) {
    throw new Error(`Missing required environment variable(s): ${key}`);
  }
  return value;
}

export function parseNonNegativeIntegerEnv(raw: string, key: string): number {
  if (!SAFE_INTEGER.test(raw)) {
    throw new Error(`Invalid environment variable: ${key}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid environment variable: ${key}`);
  }
  return parsed;
}

export function parsePositiveIntegerEnv(raw: string, key: string): number {
  const parsed = parseNonNegativeIntegerEnv(raw, key);
  if (parsed <= 0) {
    throw new Error(`Invalid environment variable: ${key}`);
  }
  return parsed;
}

export function parseBooleanEnv(raw: string, key: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid environment variable: ${key}`);
}

export function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid environment variable: CORS_ORIGINS");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid environment variable: CORS_ORIGINS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Invalid environment variable: CORS_ORIGINS");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Invalid environment variable: CORS_ORIGINS");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("Invalid environment variable: CORS_ORIGINS");
  }
  return `${url.protocol}//${url.host}`;
}

export function parseCorsOriginsEnv(raw: string): string[] {
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const origin = normalizeOrigin(trimmed);
    if (seen.has(origin)) continue;
    seen.add(origin);
    origins.push(origin);
  }
  if (origins.length === 0) {
    throw new Error("Invalid environment variable: CORS_ORIGINS");
  }
  return origins;
}

export function resolveTrustProxyHops(env: NodeJS.ProcessEnv): number {
  const raw = getOptionalEnv(env, "TRUST_PROXY_HOPS");
  if (raw === undefined) return 1;
  return parseNonNegativeIntegerEnv(raw, "TRUST_PROXY_HOPS");
}
