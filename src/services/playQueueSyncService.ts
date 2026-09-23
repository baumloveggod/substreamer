/**
 * Server-side play queue sync — pause here, carry on there.
 *
 * Separate from `queuePersistenceService`, which keeps the local SQLite snapshot
 * this app restores from on launch. This one mirrors the queue to the SERVER
 * (`savePlayQueue` / `getPlayQueue`) so another client can pick it up.
 *
 * Every Subsonic server we have source for implements both endpoints, so there
 * is no capability gate; a server that does not answer surfaces as a failure the
 * caller reports to the user.
 */

import { playerStore } from '../store/playerStore';
import { playbackSettingsStore } from '../store/playbackSettingsStore';
import {
  getPlayQueue,
  savePlayQueue,
  type Child,
  type ServerPlayQueue,
} from './subsonicService';

/**
 * How many bytes of `&id=…` parameters one save may spend.
 *
 * `savePlayQueue` is a GET, and a queue built by "shuffle everything" runs to
 * thousands of tracks — far past what a reverse proxy accepts on a request line
 * (nginx `large_client_header_buffers` 8k, Apache `LimitRequestLine` 8190). The
 * rest of the URL (host, auth token, salt, the other parameters) fits in what is
 * left over. Budgeting BYTES rather than a track count adapts to both short ids
 * (gonic's `tr-123`) and long ones (Navidrome's hashes).
 */
const ID_PARAM_BUDGET_BYTES = 6000;

/** Track changes counted since the last automatic save. */
let trackChangesSinceSave = 0;

/** Reset the autosave counter — used on logout and by the tests. */
export function resetQueueSyncCounter(): void {
  trackChangesSinceSave = 0;
}

function idParamCost(id: string): number {
  return '&id='.length + encodeURIComponent(id).length;
}

/**
 * The longest run of ids around `index` that fits the budget, plus where the
 * current track ended up in it. Fills forward first — what comes after the
 * cursor is what the other device is going to play — then backward with
 * whatever is left. Returns `null` when even the current track does not fit.
 */
export function selectIdsWithinBudget(
  queue: Child[],
  index: number,
): { ids: string[]; index: number } | null {
  if (queue.length === 0) return null;
  const cursor = Math.min(Math.max(0, index), queue.length - 1);

  let used = idParamCost(queue[cursor].id);
  if (used > ID_PARAM_BUDGET_BYTES) return null;

  let end = cursor;
  while (end + 1 < queue.length) {
    const cost = idParamCost(queue[end + 1].id);
    if (used + cost > ID_PARAM_BUDGET_BYTES) break;
    used += cost;
    end++;
  }

  let start = cursor;
  while (start - 1 >= 0) {
    const cost = idParamCost(queue[start - 1].id);
    if (used + cost > ID_PARAM_BUDGET_BYTES) break;
    used += cost;
    start--;
  }

  return {
    ids: queue.slice(start, end + 1).map((c) => c.id),
    index: cursor - start,
  };
}

/**
 * Push the current queue, cursor and position to the server. Returns false when
 * there is nothing to save or the server rejected it.
 */
export async function saveQueueToServer(): Promise<boolean> {
  const { queue, currentTrackIndex, position } = playerStore.getState();
  const selection = selectIdsWithinBudget(queue, currentTrackIndex ?? 0);
  if (!selection) return false;

  return savePlayQueue({
    ids: selection.ids,
    currentIndex: selection.index,
    positionMs: Math.max(0, Math.round(position * 1000)),
  });
}

/** Read the queue the server holds, or `null` when it has none. */
export async function fetchServerQueue(): Promise<ServerPlayQueue | null> {
  return getPlayQueue();
}

/**
 * Count a track change and save once the configured number has gone by. Called
 * from the player's track-change event; a no-op while autosave is off.
 */
export function onTrackChangedForQueueSync(): void {
  const { queueSyncEnabled, queueSyncInterval } = playbackSettingsStore.getState();
  if (!queueSyncEnabled) return;
  trackChangesSinceSave++;
  if (trackChangesSinceSave < queueSyncInterval) return;
  // Reset on FIRE rather than on success: a server that keeps rejecting would
  // otherwise leave the counter past the interval and retry on every track.
  trackChangesSinceSave = 0;
  void saveQueueToServer();
}

/**
 * Flush the queue to the server now, if autosave is on. Called when the app goes
 * to the background — the mobile equivalent of saving on close, and the moment
 * the user is most likely about to pick up another device.
 */
export function flushQueueToServer(): void {
  if (!playbackSettingsStore.getState().queueSyncEnabled) return;
  void saveQueueToServer();
}
