// Centralized compat boundary for the legacy reminder job. Static import works
// here (verified during Stage 4 build by reading jobs/reminderCron.js and
// emailSender.js): reminderCron.js only calls cron.schedule(...) inside
// startReminderCron()'s function body, never at module scope, and the
// emailSender.js transporter it requires is itself lazily constructed (see
// emailSender.js's getTransporter()). So importing this module — unlike
// config/db.js — has zero side effects; no lazy/deferred require is needed.
import { startReminderCron } from "../../../jobs/reminderCron";
import type { AppCollections } from "../database/database.types";

export function startLegacyReminderCron(usersCollection: AppCollections["usersCollection"]): void {
  startReminderCron(usersCollection);
}
