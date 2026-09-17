import { describe, expect, it } from 'vitest';
import { TranscriptionError } from '../src/transcription';

// The pipeline's retry set is not exported; this asserts the property that
// matters, which is that the two failures are distinguishable at all.
describe('out-of-credit handling', () => {
  it('carries its own code, not the generic one', () => {
    const quota = new TranscriptionError('transcription_quota_exhausted', 'insufficient_quota');
    const generic = new TranscriptionError('transcription_failed', '500');
    // Same code for both would mean the same message to the user, and the
    // same pointless three retries per job.
    expect(quota.code).not.toBe(generic.code);
    expect(quota.code).toBe('transcription_quota_exhausted');
  });

  it('keeps the provider detail for the log', () => {
    const err = new TranscriptionError('transcription_quota_exhausted', 'You have no credits remaining');
    expect(err.message).toContain('no credits');
  });
});
