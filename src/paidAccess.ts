// Paid access, before there is a payment provider.
//
// A new workspace can make one video for free. To go on, it picks a plan and
// leaves a phone number; the owner sends a Kaspi invoice to that number by
// hand and, once it is paid, presses "Оплата получена" in /admin. The plan
// then runs for PERIOD_DAYS with its own video limit.
//
// Enforced here, server-side, not in the interface: a hidden button is one
// request away from a free render.

import { PERIOD_DAYS, planById, TRIAL_VIDEOS, type Plan } from './plans';

/** What a tenant row says about access. */
export interface AccessRow {
  /** Workspaces that existed before payments did, and staff-created ones. */
  access_forever: boolean;
  access_until: string | Date | null;
  plan_id?: string | null;
  /** When access last opened from nothing — a period's videos are counted from here at the earliest. */
  period_started_at?: string | Date | null;
}

/**
 * - unlimited: before payments existed, staff-made, an admin, or payments off
 * - active: a paid plan that has not run out
 * - trial: never paid — the free video, then the plans page
 * - expired: paid once, and the period is over
 */
export type WorkspaceState = 'unlimited' | 'active' | 'trial' | 'expired';

export function workspaceState(row: AccessRow, opts: { isAdmin?: boolean; enforced?: boolean } = {}, now: Date = new Date()): WorkspaceState {
  if (opts.enforced === false || opts.isAdmin || row.access_forever) return 'unlimited';
  const until = row.access_until ? new Date(row.access_until) : null;
  if (until && until.getTime() > now.getTime()) return 'active';
  return until ? 'expired' : 'trial';
}

/** Whether a new edit fits: within the plan's period limit, or the trial. */
export function videoLimit(state: WorkspaceState, plan: Plan | null): number | null {
  if (state === 'unlimited') return null;
  if (state === 'trial') return TRIAL_VIDEOS;
  if (state === 'expired') return 0;
  // A paid period whose plan is unknown (granted by hand before plans, or a
  // plan since removed) is not cut off over a missing number.
  return plan ? plan.videosPerPeriod : null;
}

const PERIOD_MS = PERIOD_DAYS * 86_400_000;

/**
 * Where usage is counted from: ever for the trial, otherwise the start of the
 * paid period the workspace is in now.
 *
 * Paid time is a run of PERIOD_DAYS blocks ending at access_until (renewing
 * early appends a block), so the current block is found counting back from
 * the end. Never before period_started_at: the videos of an earlier, lapsed
 * period — or the free one — are not charged to a period paid for afresh.
 * Without a paid end (unlimited) it is simply the last PERIOD_DAYS.
 */
export function usageSince(state: WorkspaceState, row: AccessRow, now: Date = new Date()): Date | null {
  if (state === 'trial') return null;
  const until = row.access_until ? new Date(row.access_until).getTime() : null;
  if (state !== 'active' || until === null) return new Date(now.getTime() - PERIOD_MS);
  const blocks = Math.max(1, Math.ceil((until - now.getTime()) / PERIOD_MS));
  let start = until - blocks * PERIOD_MS;
  if (row.period_started_at) start = Math.max(start, new Date(row.period_started_at).getTime());
  return new Date(start);
}

export { planById };

/**
 * A Kazakhstan number as Kaspi takes it: +7 and ten digits, or null.
 *
 * Accepts what people actually type — "8 701 123 45 67", "+7(701)1234567",
 * "7011234567" — because a form that rejects the way someone writes their own
 * number reads as broken. Only +7 numbers: the invoice goes through Kaspi,
 * which does not take any other.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!/^[\d\s()+-]{10,20}$/.test(raw.trim())) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  // Ten digits is the number without the country code — but only when no
  // "+" was typed, and only starting with 7, as every Kazakhstan number does
  // after the code. "+7 701 123 45 6" and "8 701 123 45 6" are full numbers
  // missing a digit; reading them as ten local digits would send the invoice
  // to a stranger.
  if (digits.length === 10 && !raw.trim().startsWith('+') && digits.startsWith('7')) digits = `7${digits}`;
  if (digits.length !== 11 || !digits.startsWith('7')) return null;
  return `+${digits}`;
}

/**
 * Whether this email may open /admin. From ADMIN_EMAILS (comma-separated),
 * compared lowercased. Unset means nobody: an admin area that opens by
 * default is the wrong way round.
 */
export function isAdminEmail(email: string | null | undefined, raw: string | undefined = process.env.ADMIN_EMAILS): boolean {
  if (!email || !raw) return false;
  const admins = raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(email.trim().toLowerCase());
}

/**
 * Paths every workspace may use whatever its state, matched against the full
 * path (/api/...).
 *
 * - /api/billing: seeing its plan, choosing one, leaving the invoice number.
 * - /api/account: deleting the account. The right to have one's data erased
 *   (the Kazakhstan personal data law) does not depend on paying.
 * - /api/admin: guarded by its own check.
 */
const ALWAYS_OPEN = [/^\/api\/billing(\/|$)/, /^\/api\/account$/, /^\/api\/admin(\/|$)/];

/**
 * What the trial reaches on top of that: the video editor, which is what the
 * free video is for, and the notification bell every screen's header loads.
 * The rest of the product waits for a plan — each of its AI calls costs money
 * a trial was never meant to spend.
 */
const TRIAL_OPEN = [/^\/api\/video-uploads$/, /^\/api\/video-edit-jobs(\/|$)/, /^\/api\/notifications(\/|$)/, /^\/api\/push\//];

export function pathAllowed(state: WorkspaceState, path: string): boolean {
  if (state === 'unlimited' || state === 'active') return true;
  if (ALWAYS_OPEN.some((p) => p.test(path))) return true;
  return state === 'trial' && TRIAL_OPEN.some((p) => p.test(path));
}

/** Days an admin may grant in one action: never open-ended by typo. */
export const MAX_GRANT_DAYS = 366;
