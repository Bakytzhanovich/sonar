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
  if (!env.SIGNUP_INVITE_CODE) {
    warnings.push(
      '[api] SIGNUP_INVITE_CODE is unset — self-serve signup is closed. Set it to the code invited users should present.'
    );
  }
  return warnings;
}
