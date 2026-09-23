jest.mock('../subsonicService');
jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import { scrobbleExclusionStore } from '../../store/scrobbleExclusionStore';
import { serverInfoStore } from '../../store/serverInfoStore';
import { playbackSettingsStore } from '../../store/playbackSettingsStore';
import { reportPlayback } from '../subsonicService';
import {
  reportPlaybackPosition,
  reportPlaybackState,
  reportTrackChange,
  resetPlaybackReportThrottle,
} from '../playbackReportService';

const mockReportPlayback = reportPlayback as jest.Mock;

const SONG = { id: 's1', title: 'Song', artist: 'Artist', duration: 180 } as any;

function setExtensions(names: string[]): void {
  serverInfoStore.setState({
    extensions: names.map((name) => ({ name, versions: [1] })),
  });
}

beforeEach(() => {
  mockReportPlayback.mockReset();
  mockReportPlayback.mockResolvedValue(true);
  scrobbleExclusionStore.setState({ excludedAlbums: {}, excludedArtists: {}, excludedPlaylists: {} });
  setExtensions(['playbackReport']);
  playbackSettingsStore.setState({ reportPlaybackEnabled: true, playbackRate: 1 });
  resetPlaybackReportThrottle();
});

describe('reportPlaybackState', () => {
  it('reports the state with the position in milliseconds', async () => {
    await reportPlaybackState('paused', SONG, 42.4);
    expect(mockReportPlayback).toHaveBeenCalledWith({
      id: 's1',
      state: 'paused',
      positionMs: 42400,
      playbackRate: 1,
    });
  });

  it('carries the configured playback rate', async () => {
    playbackSettingsStore.setState({ playbackRate: 1.5 });
    await reportPlaybackState('playing', SONG, 0);
    expect(mockReportPlayback.mock.calls[0][0].playbackRate).toBe(1.5);
  });

  it('never sends a negative position', async () => {
    await reportPlaybackState('playing', SONG, -5);
    expect(mockReportPlayback.mock.calls[0][0].positionMs).toBe(0);
  });

  it('does nothing without a song', async () => {
    await reportPlaybackState('playing', null, 0);
    expect(mockReportPlayback).not.toHaveBeenCalled();
  });

  it('does nothing when the setting is off', async () => {
    playbackSettingsStore.setState({ reportPlaybackEnabled: false });
    await reportPlaybackState('playing', SONG, 0);
    expect(mockReportPlayback).not.toHaveBeenCalled();
  });

  it('does nothing when the server does not advertise the extension', async () => {
    setExtensions(['songLyrics']);
    await reportPlaybackState('playing', SONG, 0);
    expect(mockReportPlayback).not.toHaveBeenCalled();
  });

  it('honours a scrobble exclusion on the album', async () => {
    scrobbleExclusionStore.setState({ excludedAlbums: { a1: true } as any });
    await reportPlaybackState('playing', { ...SONG, albumId: 'a1' }, 0);
    expect(mockReportPlayback).not.toHaveBeenCalled();
  });

  it('honours a scrobble exclusion on the source playlist', async () => {
    scrobbleExclusionStore.setState({ excludedPlaylists: { p1: true } as any });
    await reportPlaybackState('playing', SONG, 0, 'p1');
    expect(mockReportPlayback).not.toHaveBeenCalled();
  });

  it('resolves quietly when the server rejects the report', async () => {
    // subsonicService.reportPlayback swallows transport failures and answers
    // false; nothing here should turn that into a rejection callers must catch.
    mockReportPlayback.mockResolvedValue(false);
    await expect(reportPlaybackState('playing', SONG, 0)).resolves.toBeUndefined();
  });
});

describe('reportPlaybackPosition', () => {
  it('reports the first seek', () => {
    reportPlaybackPosition('playing', SONG, 10);
    expect(mockReportPlayback).toHaveBeenCalledTimes(1);
  });

  it('throttles a burst of seeks to one report', () => {
    reportPlaybackPosition('playing', SONG, 10);
    reportPlaybackPosition('playing', SONG, 20);
    reportPlaybackPosition('playing', SONG, 30);
    expect(mockReportPlayback).toHaveBeenCalledTimes(1);
  });

  it('reports again once the throttle window has passed', () => {
    reportPlaybackPosition('playing', SONG, 10);
    resetPlaybackReportThrottle();
    reportPlaybackPosition('paused', SONG, 20);
    expect(mockReportPlayback).toHaveBeenCalledTimes(2);
    expect(mockReportPlayback.mock.calls[1][0].state).toBe('paused');
  });
});

describe('reportTrackChange', () => {
  it('stops the outgoing track, then starts and plays the incoming one', async () => {
    const next = { ...SONG, id: 's2' };
    await reportTrackChange(SONG, 175, next);
    expect(mockReportPlayback.mock.calls.map((c) => [c[0].id, c[0].state, c[0].positionMs])).toEqual([
      ['s1', 'stopped', 175000],
      ['s2', 'starting', 0],
      ['s2', 'playing', 0],
    ]);
  });

  it('reports only the incoming track when nothing was playing', async () => {
    await reportTrackChange(null, 0, SONG);
    expect(mockReportPlayback.mock.calls.map((c) => c[0].state)).toEqual(['starting', 'playing']);
  });

  it('reports only the outgoing track at the end of a queue', async () => {
    await reportTrackChange(SONG, 30, null);
    expect(mockReportPlayback.mock.calls.map((c) => c[0].state)).toEqual(['stopped']);
  });

  it('abandons a chain that a newer track change has overtaken', async () => {
    const first = reportTrackChange(SONG, 30, { ...SONG, id: 's2' });
    const second = reportTrackChange({ ...SONG, id: 's2' }, 0, { ...SONG, id: 's3' });
    await Promise.all([first, second]);
    // The overtaken chain must not leave s2 as the server's playing track.
    expect(mockReportPlayback.mock.calls.at(-1)?.[0]).toMatchObject({
      id: 's3',
      state: 'playing',
    });
  });

  it('clears the seek throttle so the new track can report immediately', async () => {
    reportPlaybackPosition('playing', SONG, 10);
    mockReportPlayback.mockClear();
    await reportTrackChange(SONG, 30, { ...SONG, id: 's2' });
    reportPlaybackPosition('playing', { ...SONG, id: 's2' }, 5);
    expect(mockReportPlayback.mock.calls.at(-1)?.[0]).toMatchObject({ id: 's2', positionMs: 5000 });
  });
});
