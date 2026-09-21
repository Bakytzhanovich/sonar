// Who may do what inside one workspace.
//
// Until now a tenant was one person, so "authenticated" and "allowed" were the
// same question. An agency is several: the person who runs it, the editors who
// make the reels, and the client who wants to see the numbers without being
// able to rewrite the bot that talks to their audience.
//
// The rule is default-deny by method rather than an annotation per route.
// Annotating ~60 routes would work until someone adds the sixty-first and
// forgets, and the failure mode of forgetting is an unprotected endpoint that
// nothing complains about. Here a new route is covered the moment it exists:
// if it reads it is a read, if it writes it is a write, and it takes a
// deliberate act — adding a path to a list below — to make it anything else.

export type Role = 'owner' | 'editor' | 'viewer';

export const ROLES: Role[] = ['owner', 'editor', 'viewer'];

/**
 * Roles are ranked, and a higher rank can do everything a lower one can.
 *
 * Ranking rather than a permission matrix because these three genuinely nest —
 * an owner is an editor who can also manage people. A matrix would let the
 * three drift into shapes that do not, which is more expressive than anyone
 * here needs and easier to get subtly wrong.
 */
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as string[]).includes(value);
}

/** An unreadable or absent role is treated as the weakest, never the strongest. */
export function asRole(value: unknown): Role {
  return isRole(value) ? value : 'viewer';
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes that change only the acting person's own state, never the workspace's.
 *
 * A viewer has to be able to mute their own notifications and register their
 * own browser for push. Refusing those would not protect anything — the data
 * belongs to them — and would make the read-only role feel broken rather than
 * limited.
 */
const SELF_SCOPED_WRITES = [
  '/api/push/subscribe',
  '/api/push/unsubscribe',
  '/api/notifications/read-all',
  // POST /api/notifications/:id/read
  /^\/api\/notifications\/[^/]+\/read$/,
];

/**
 * Paths only an owner may touch, whatever the method.
 *
 * Managing people is the one power an editor must not have: an editor who can
 * invite is an editor who can promote themselves, and the distinction between
 * the roles stops meaning anything.
 */
const OWNER_ONLY = [/^\/api\/members(\/|$)/];

function matches(path: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((p) => (typeof p === 'string' ? p === path : p.test(path)));
}

/**
 * The least role that may issue this request.
 *
 * `path` is the pathname only — a query string must not be able to change the
 * answer.
 */
export function requiredRole(method: string, path: string): Role {
  if (matches(path, OWNER_ONLY)) return 'owner';
  if (READ_METHODS.has(method.toUpperCase())) return 'viewer';
  if (matches(path, SELF_SCOPED_WRITES)) return 'viewer';
  return 'editor';
}

export function canPerform(role: Role, method: string, path: string): boolean {
  return RANK[role] >= RANK[requiredRole(method, path)];
}

/** Russian labels, for the interface and for the refusal message. */
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Владелец',
  editor: 'Редактор',
  viewer: 'Наблюдатель',
};
