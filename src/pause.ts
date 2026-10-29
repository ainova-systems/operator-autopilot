import type { DocStore } from './state/types.ts';

/** The runtime's own switches; `operator state` cannot write here. */
export const CONTROL_COLLECTION = 'control';
const PAUSE_KEY = 'pause';

/**
 * A pause: no timer fires and no queued job starts, while running jobs finish. `quietAt` is when the
 * daemon first saw no job running under this pause - the moment the host can be stopped safely.
 */
export interface PauseRecord {
  since: string;
  by: string;
  reason?: string;
  quietAt?: string;
}

export async function readPause(docs: DocStore): Promise<PauseRecord | undefined> {
  return (await docs.get<PauseRecord>(CONTROL_COLLECTION, PAUSE_KEY))?.value;
}

/** Pauses unless a pause already stands; answers the pause in force. */
export async function requestPause(docs: DocStore, by: string, reason?: string, now: Date = new Date()): Promise<{ pause: PauseRecord; created: boolean }> {
  const pause: PauseRecord = { since: now.toISOString(), by, ...(reason ? { reason } : {}) };
  if ((await docs.create(CONTROL_COLLECTION, PAUSE_KEY, pause)) === 'created') return { pause, created: true };
  return { pause: (await readPause(docs)) ?? pause, created: false };
}

/** Ends the pause; false when none stood. */
export async function clearPause(docs: DocStore): Promise<boolean> {
  return docs.delete(CONTROL_COLLECTION, PAUSE_KEY);
}

/** Records that this pause went quiet, unless the pause changed meanwhile. */
export async function markQuiet(docs: DocStore, pause: PauseRecord, at: Date): Promise<void> {
  const current = await docs.get<PauseRecord>(CONTROL_COLLECTION, PAUSE_KEY);
  if (!current || current.value.since !== pause.since || current.value.quietAt) return;
  await docs.replace(CONTROL_COLLECTION, PAUSE_KEY, { ...current.value, quietAt: at.toISOString() }, { etag: current.etag });
}
