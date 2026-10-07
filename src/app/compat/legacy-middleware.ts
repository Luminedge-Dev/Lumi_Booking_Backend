import { initAuth } from "../../../middleware/auth";
import type { AppCollections } from "../database/database.types";

export function initLegacyAuth(usersCollection: AppCollections["usersCollection"]): void {
  initAuth(usersCollection);
}
