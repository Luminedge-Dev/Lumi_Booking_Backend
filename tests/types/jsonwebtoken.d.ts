// Minimal test-only declarations for the jsonwebtoken runtime API surface
// used by characterization tests. @types/jsonwebtoken is out of scope for
// Stage 3, so only the actually-used member is declared here.
declare module "jsonwebtoken" {
  export function sign(
    payload: Record<string, unknown>,
    secret: string
  ): string;
}
