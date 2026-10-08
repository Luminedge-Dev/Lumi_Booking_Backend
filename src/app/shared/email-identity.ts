// Shared email-identity helpers. Register (Stage 15) and approve-profile-edit
// (Stage 16B P1) take the same transaction-scoped advisory lock so they cannot
// both commit the same normalized address. This is not a uniqueness constraint
// and is not a global guarantee: any writer that skips the lock can still race.

export const EMAIL_LOCK_SEED = 15;

export function normalizeEmailIdentity(email: string): string {
  return email.trim().toLowerCase();
}
