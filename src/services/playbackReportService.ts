/**
 * Live playback reporting via the OpenSubsonic `playbackReport` extension.
 *
 * Tells the server what this client is doing right now — which track, playing or
 * paused, and how far in — so the server's "now playing" reflects the real state
 * instead of only the start of a track.
 *
 * This is NOT scrobbling. `subsonicService.reportPlayback` always sets
 * `ignoreScrobble`, because `scrobbleService` already submits plays through
 * `scrobble.view`.
 */

import { playbackSettingsStore } from '../store/playbackSettingsStore';
import { isExcluded } from './scrobbleService';
import { supportsExtension } from './serverCapabilityService';
import { reportPlayback, type Child, type PlaybackReportState } from './subsonicService';

export type { PlaybackReportState };

/** Minimum gap between position-only reports (a seek), so a scrub doesn't flood. */
const POSITION_REPORT_INTERVAL_MS = 1000;

let lastPositionReportTime = 0;
/** Bumped per track change; a chain whose number is stale abandons its rest. */
let trackChangeSequence = 0;

/** Reset the seek throttle — a new track starts with a clean slate. */
export function resetPlaybackReportThrottle(): void {
  lastPositionReportTime = 0;
}

function canReport(song: Child | null, playlistId?: string): song is Child {
  if (!song?.id) return false;
  if (!playbackSettingsStore.getState().reportPlaybackEnabled) return false;
  if (!supportsExtension('playbackReport')) return false;
  return !isExcluded(song, playlistId);
}

/**
 * Report a state transition. Fire-and-forget: the server's view of "now playing"
 * is ephemeral, so a failed report is not worth surfacing or retrying.
 */
export async function reportPlaybackState(
  state: PlaybackReportState,
  song: Child | null,
  positionSec: number,
  playlistId?: string,
): Promise<void> {
  if (!canReport(song, playlistId)) return;
  await reportPlayback({
    id: song.id,
    state,
    positionMs: Math.max(0, Math.round(positionSec * 1000)),
    playbackRate: playbackSettingsStore.getState().playbackRate,
  });
}

/**
 * Report a new position for the track already loaded, keeping whatever state it
 * is in. Used after a seek; throttled because a scrub emits a burst.
 */
export function reportPlaybackPosition(
  state: Extract<PlaybackReportState, 'paused' | 'playing'>,
  song: Child | null,
  positionSec: number,
  playlistId?: string,
): void {
  const now = Date.now();
  if (now - lastPositionReportTime < POSITION_REPORT_INTERVAL_MS) return;
  lastPositionReportTime = now;
  void reportPlaybackState(state, song, positionSec, playlistId);
}

/**
 * Report that a track took over: the outgoing one stopped, the incoming one is
 * starting. `starting` opens the server-side session and `playing` puts a real
 * state on it — Navidrome's tracker treats them as distinct steps, and a
 * `starting` arriving late on an already-playing session is ignored.
 */
export async function reportTrackChange(
  outgoing: Child | null,
  outgoingPositionSec: number,
  incoming: Child | null,
  outgoingPlaylistId?: string,
  incomingPlaylistId?: string,
): Promise<void> {
  resetPlaybackReportThrottle();
  // Mashing skip overlaps these chains, and a late 'playing' for a track the user
  // has already left would drag the server's session back onto it.
  const sequence = ++trackChangeSequence;
  await reportPlaybackState('stopped', outgoing, outgoingPositionSec, outgoingPlaylistId);
  if (sequence !== trackChangeSequence) return;
  await reportPlaybackState('starting', incoming, 0, incomingPlaylistId);
  if (sequence !== trackChangeSequence) return;
  await reportPlaybackState('playing', incoming, 0, incomingPlaylistId);
}
