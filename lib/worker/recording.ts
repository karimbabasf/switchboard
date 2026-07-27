/**
 * Recording fetch step: downloads a Telnyx presigned recording URL into
 * Supabase Storage and returns the storage path to persist on the call.
 *
 * CRITICAL: Telnyx presigned recording URLs are valid for exactly 10 minutes
 * from the moment the webhook received them, which is also (near enough) the
 * moment this row was inserted with status 'new'. A row that ages past that
 * window can never be fetched, no matter how many attempts are left, so it is
 * failed outright here rather than left to retry forever.
 */

import { env } from '../env';
import { db } from '../db';
import type { Call } from '../types';

/** Telnyx presigned recording URLs are valid for exactly 10 minutes. */
export const RECORDING_URL_TTL_MS = 10 * 60 * 1000;

export class RecordingExpiredError extends Error {
  constructor(ageMs: number) {
    super(
      `recording_url is ${Math.round(ageMs / 1000)}s old, past the ${RECORDING_URL_TTL_MS / 1000}s Telnyx presigned URL window`,
    );
    this.name = 'RecordingExpiredError';
  }
}

/** Age is measured from created_at: the webhook inserts the row the instant the presigned URL arrives. */
export function isExpired(call: Pick<Call, 'created_at'>, now: Date): boolean {
  return now.getTime() - new Date(call.created_at).getTime() > RECORDING_URL_TTL_MS;
}

/**
 * Downloads the recording and uploads it to Storage. Returns the bucket-relative
 * storage path; the caller persists it onto the call row.
 */
export async function fetchRecording(call: Call, now: Date): Promise<string> {
  if (!call.recording_url) {
    throw new Error(`call ${call.id} has no recording_url`);
  }
  if (isExpired(call, now)) {
    throw new RecordingExpiredError(now.getTime() - new Date(call.created_at).getTime());
  }

  const res = await fetch(call.recording_url);
  if (!res.ok) {
    throw new Error(`recording download failed: HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
  const buffer = Buffer.from(await res.arrayBuffer());

  const bucket = env('SUPABASE_STORAGE_BUCKET');
  const path = `${call.id}.${extensionFor(contentType)}`;

  const { error } = await db().storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`storage upload failed: ${error.message}`);

  return path;
}

function extensionFor(contentType: string): string {
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
  return 'mp3';
}
