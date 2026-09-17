import { timingSafeEqualStrings } from './webhookAuth';

// Two routes hand out a working credential to whoever calls them, and neither
// requires one to begin with: POST /api/tenants answers with a tenant API key
// in plaintext, and POST /api/auth/signup creates an account and a session.
//
// That is correct for development, where the alternative is a chicken-and-egg
// problem, and wrong on a public address. Left open in production, a stranger
// registers a tenant and runs renders — which means transcription billed to
// our OpenAI account and video sitting in our bucket, both without limit.
//
// The gate is deliberately the same shape for both: a secret from the
// environment, compared in constant time, and CLOSED when production has not
// configured one. Failing closed is the whole point. An unset variable is far
// more likely to be an oversight during a deploy than a decision to let the
// internet in, and the failure modes are not symmetric — a locked-out owner
// notices in a minute and sets the variable, while an open signup is noticed
// when the bill arrives.

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: 'not_configured' | 'bad_secret' };

interface GateInput {
  isProduction: boolean;
  /** The expected value, from the environment. Null when unset. */
  configuredSecret: string | null;
  /** Whatever the caller presented — a header or a body field, so unknown. */
  providedSecret: unknown;
}

/**
 * Whether a request carrying `providedSecret` may pass.
 *
 * Note the order: a configured secret is enforced in development too. Setting
 * one and having it ignored locally would mean the check is first exercised
 * in production, which is where a mistake in it costs the most.
 */
export function evaluateGate({ isProduction, configuredSecret, providedSecret }: GateInput): GateDecision {
  if (configuredSecret !== null && configuredSecret !== '') {
    if (typeof providedSecret !== 'string' || providedSecret === '') {
      return { allowed: false, reason: 'bad_secret' };
    }
    // Constant-time, over digests: see webhookAuth.ts. A secret compared with
    // === leaks its prefix through timing, and these are guessable in exactly
    // the way that matters — an attacker can retry as often as the rate
    // limiter allows.
    return timingSafeEqualStrings(providedSecret, configuredSecret)
      ? { allowed: true }
      : { allowed: false, reason: 'bad_secret' };
  }

  // Nothing configured. Open in development, closed in production.
  return isProduction ? { allowed: false, reason: 'not_configured' } : { allowed: true };
}

/** Header carrying the bootstrap secret for POST /api/tenants. */
export const ADMIN_SECRET_HEADER = 'x-sonar-admin-secret';

/**
 * Whether anyone may create an account, or only someone holding the code.
 *
 * Open signup is a deliberate word, never an omission. That asymmetry is the
 * point: SIGNUP_INVITE_CODE going missing during a deploy closes the door,
 * while opening it takes someone typing `open` on purpose. Both states are
 * legitimate; only one of them can happen by accident, and it is the safe one.
 *
 * What bounds the damage while it is open is the OpenAI balance, not this
 * code: a stranger who registers can spend up to whatever is on the account
 * and not a cent more. Keep the balance small and auto-recharge off, and the
 * ceiling stays real.
 */
export function signupDecision(input: GateInput & { signupMode: string | undefined }): GateDecision {
  if (input.signupMode === 'open') return { allowed: true };
  return evaluateGate(input);
}

/**
 * The same decision as a state the signup form can render.
 *
 * Three values rather than "is a code needed?", because closed and
 * invite-only are different things to a visitor: one can be solved by asking
 * someone for a code, the other cannot be solved at all. A form that asks for
 * a code that does not exist wastes the visitor's time and looks broken.
 */
export function signupAvailability(
  input: Omit<GateInput, 'providedSecret'> & { signupMode: string | undefined }
): 'open' | 'invite' | 'closed' {
  if (input.signupMode === 'open') return 'open';
  if (input.configuredSecret) return 'invite';
  return input.isProduction ? 'closed' : 'open';
}

/**
 * Warnings for the boot log.
 *
 * Emitted at startup rather than on the first refused request: a closed
 * signup looks identical to a broken one from the outside, and whoever
 * deployed it should learn which it is before a client does.
 */
export function gateStartupWarnings(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const warnings: string[] = [];

  if (!env.ADMIN_BOOTSTRAP_SECRET) {
    warnings.push(
      '[api] ADMIN_BOOTSTRAP_SECRET is unset — POST /api/tenants is closed. Set it to issue tenant API keys in production.'
    );
  }
  if (env.SIGNUP_MODE === 'open') {
    // Not a warning about a mistake — a statement of a consequential state,
    // in the log where someone reading a deploy will see it.
    warnings.push(
      '[api] SIGNUP_MODE=open — anyone may register. Spending is capped only by the OpenAI balance; keep auto-recharge off.'
    );
  } else if (!env.SIGNUP_INVITE_CODE) {
    warnings.push(
      '[api] SIGNUP_INVITE_CODE is unset — self-serve signup is closed. Set it, or set SIGNUP_MODE=open to let anyone register.'
    );
  }
  return warnings;
}

/**
 * An origin as it will be compared and sent back in a header.
 *
 * Trims surrounding whitespace (a newline from a copy-paste into a hosting
 * panel is the common case) and drops trailing slashes, which an Origin
 * header never has. Returns undefined for anything left empty, so callers
 * keep treating "not set" as one case.
 */
export function normalizeOrigin(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}
