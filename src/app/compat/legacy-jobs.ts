import { startReminderCron } from "../../../jobs/reminderCron";
import type { AppCollections } from "../database/database.types";

export function startLegacyReminderCron(usersCollection: AppCollections["usersCollection"]): void {
  startReminderCron(usersCollection);
}
