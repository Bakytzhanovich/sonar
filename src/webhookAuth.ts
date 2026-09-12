import { createHash, timingSafeEqual } from 'node:crypto';

// The mock webhook stands in for Meta calling us, so by construction it
// cannot carry a tenant API key (Meta doesn't have one). That left it as
// the only unauthenticated write path in the entire API, and a reachable
// one: a bot's external_account_id is an Instagram handle, i.e. public
// information, so anyone could drive real flow runs against a client's
// account — sending DMs from it (risking the platform ban CLAUDE.md's
// rate-limiting requirement exists to prevent) and injecting contacts into
// that client's CRM, which also corrupts the conversion analytics that
// CLAUDE.md's test-mode rule protects.
//
// Two independent gates close it, deliberately layered so neither alone is
// load-bearing:
//
//  1. MOCK_WEBHOOK_ENABLED — this route is a development simulator, so it
//     does not exist unless explicitly switched on. A normal production
//     deploy therefore has no mock webhook surface at all. The first-party
//     browser product does not need it either: its "simulate an incoming
//     DM" panel calls the tenant-scoped, authenticated
//     POST /api/bots/:botId/simulate-incoming instead, so no secret is ever
//     shipped to a browser bundle.
//  2. MOCK_WEBHOOK_SECRET — where the simulator IS wanted (the staff-
//     assisted demo environment the current MVP runs on), callers must
//     present the shared secret in X-Sonar-Webhook-Secret.
//
// The real POST /webhooks/instagram will keep gate 1 off and replace gate 2
// with Meta's X-Hub-Signature-256 HMAC — verified through the same
// timing-safe comparison below, which is why that helper is exported.
export const MOCK_WEBHOOK_SECRET_HEADER = 'x-sonar-webhook-secret';

const TEST_SECRET = 'test-mock-webhook-secret';

// Compares over SHA-256 digests rather than the raw strings: timingSafeEqual
// throws on length mismatch, and the length of a rejected credential is
// itself something an attacker can probe for. Digesting first makes both
// sides a fixed 32 bytes, so every wrong answer costs the same time.
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

// Read at call time, not module load, so a test or a process that sets the
// variable after import still sees it (auth.ts can read SESSION_SECRET once
// at load because it is mandatory there; these two are optional switches).
export function isMockWebhookEnabled(): boolean {
  if (process.env.MOCK_WEBHOOK_ENABLED === 'true') return true;
  // vitest sets NODE_ENV=test itself — the suite exercises the real webhook
  // contract (event_id dedup, unknown account, flow outcomes), so the route
  // has to exist there without any environment setup.
  return process.env.NODE_ENV === 'test';
}

export function mockWebhookSecret(): string | undefined {
  return process.env.MOCK_WEBHOOK_SECRET ?? (process.env.NODE_ENV === 'test' ? TEST_SECRET : undefined);
}

export function verifyMockWebhookSecret(provided: unknown): boolean {
  const expected = mockWebhookSecret();
  // Enabled with no secret configured is a misconfiguration, not an
  // invitation — server.ts refuses to start in that state, and this rejects
  // every request in case the route is somehow reached anyway.
  if (!expected) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return timingSafeEqualStrings(provided, expected);
}

// Called at startup so a deploy that switches the simulator on without a
// secret fails loudly there, rather than serving a route that silently
// 401s every request. Same reasoning as auth.ts's SESSION_SECRET check.
export function assertMockWebhookConfig(): void {
  if (process.env.MOCK_WEBHOOK_ENABLED === 'true' && !process.env.MOCK_WEBHOOK_SECRET) {
    throw new Error(
      'MOCK_WEBHOOK_ENABLED=true requires MOCK_WEBHOOK_SECRET — refusing to expose an unauthenticated webhook that can send DMs from a client account'
    );
  }
}
