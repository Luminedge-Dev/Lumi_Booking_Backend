import type { AuthActor } from "../../modules/auth/auth.types";

// Authenticated actor attached by the Auth middleware.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthActor;
    }
  }
}

export {};
