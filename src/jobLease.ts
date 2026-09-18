// How long a worker's claim on a job stays valid, and what it means when it
// has not been claimed at all.
//
// Its own module, with no imports, because both sides need it: the worker
// stamps and honours the lease, and the API reads it to tell a waiting job
// from a rendering one. Keeping it in videoPipeline.ts would have made the
// API import ffmpeg, transcription and object storage to answer a question
// about two columns.

/**
 * A claim older than this is treated as abandoned — the worker holding it
 * crashed, was killed mid-render, or had its machine closed.
 *
 * Generous on purpose: a long source on a slow instance can spend many
 * minutes inside one stage, and expiring a live claim would hand the same
 * job to a second worker while the first is still encoding it.
 */
export const CLAIM_LEASE_MS = 30 * 60 * 1000;

/**
 * Whether a job is sitting in the queue rather than being worked on.
 *
 * The status alone cannot tell them apart: a job stays 'processing' from
 * creation until it finishes, so an untouched job and one halfway through a
 * render look identical from outside. What separates them is the lease —
 * claimed_at is stamped when a worker takes the job and refreshed while the
 * render runs.
 *
 * This matters because the two states need different words. A progress bar
 * frozen at 0% under the label "Рендерится" reads as a broken site. The owner
 * of this one read it exactly that way, and he knew how it worked; a client
 * who does not would simply leave.
 */
export function isAwaitingWorker(
  job: { status: string; claimed_at: string | null },
  now: Date,
  leaseMs: number = CLAIM_LEASE_MS
): boolean {
  if (job.status !== 'processing') return false;
  if (!job.claimed_at) return true;

  const claimedAt = new Date(job.claimed_at).getTime();
  // An unparseable timestamp is not a reason to claim a job is being worked
  // on — the honest answer to "is someone on this?" is then "we cannot tell",
  // and "waiting" is the version of that which does not promise progress.
  if (Number.isNaN(claimedAt)) return true;

  return claimedAt < now.getTime() - leaseMs;
}
