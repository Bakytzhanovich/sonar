// Per-account throttling for sign-in attempts.
//
// The IP rate limit in api.ts caps a single address, which stops a lone
// script but not an attacker with a list of addresses: at 20 attempts per 15
// minutes across ten IPs, one account still absorbs ~1900 guesses a day —
// comfortably enough for a password a person chose themselves. This counts
// failures against the ACCOUNT instead, so the budget is shared no matter
// where the attempts come from.
//
// The obvious danger of locking an account is that anyone can then lock
// anyone else out on purpose, which converts a password-guessing defence
// into a denial-of-service hole. Three things keep that survivable:
//
//   - the lock is short, and expires on its own
//   - the correct password clears it immediately, so the real owner is
//     delayed rather than shut out
//   - it takes effect only after several consecutive failures, so a user
//     mistyping their own password never meets it

export const MAX_FAILED_ATTEMPTS = 5;

// Long enough to make guessing hopeless (5 tries per 15 minutes is ~480 a
// day, against a keyspace where that is nothing), short enough that a
// locked-out owner waits rather than files a support ticket.
export const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface ThrottleState {
  failed_logins: number;
  locked_until: string | Date | null;
}

export function isLocked(user: ThrottleState | undefined, now: Date): boolean {
  if (!user?.locked_until) return false;
  return new Date(user.locked_until).getTime() > now.getTime();
}

export function secondsUntilUnlock(user: ThrottleState | undefined, now: Date): number {
  if (!user?.locked_until) return 0;
  const remaining = new Date(user.locked_until).getTime() - now.getTime();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

/**
 * The account's state after one more failed attempt.
 *
 * Counting past the threshold rather than resetting to it: the counter is
 * also the record of how hard this account is being attacked, which is worth
 * having when someone asks why an owner keeps getting locked out.
 */
export function nextFailureState(user: ThrottleState, now: Date): { failedLogins: number; lockedUntil: Date | null } {
  const failedLogins = user.failed_logins + 1;
  const lockedUntil = failedLogins >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCK_DURATION_MS) : null;
  return { failedLogins, lockedUntil };
}
