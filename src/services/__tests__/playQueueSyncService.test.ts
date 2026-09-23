jest.mock('../subsonicService');
jest.mock('../../store/persistence/kvStorage', () => require('../../store/persistence/__mocks__/kvStorage'));

import { playerStore } from '../../store/playerStore';
import { playbackSettingsStore } from '../../store/playbackSettingsStore';
import { getPlayQueue, savePlayQueue } from '../subsonicService';
import {
  fetchServerQueue,
  flushQueueToServer,
  onTrackChangedForQueueSync,
  resetQueueSyncCounter,
  saveQueueToServer,
  selectIdsWithinBudget,
} from '../playQueueSyncService';

const mockSavePlayQueue = savePlayQueue as jest.Mock;
const mockGetPlayQueue = getPlayQueue as jest.Mock;

function song(id: string) {
  return { id, title: id, artist: 'Artist', duration: 180 } as any;
}

function setPlayerQueue(ids: string[], index: number, position = 0): void {
  playerStore.setState({
    queue: ids.map(song),
    currentTrackIndex: index,
    position,
  });
}

beforeEach(() => {
  mockSavePlayQueue.mockReset();
  mockSavePlayQueue.mockResolvedValue(true);
  mockGetPlayQueue.mockReset();
  mockGetPlayQueue.mockResolvedValue(null);
  playbackSettingsStore.setState({ queueSyncEnabled: true, queueSyncInterval: 3 });
  setPlayerQueue([], 0);
  resetQueueSyncCounter();
});

describe('selectIdsWithinBudget', () => {
  it('returns the whole queue when it fits', () => {
    expect(selectIdsWithinBudget([song('a'), song('b'), song('c')], 1)).toEqual({
      ids: ['a', 'b', 'c'],
      index: 1,
    });
  });

  it('returns null for an empty queue', () => {
    expect(selectIdsWithinBudget([], 0)).toBeNull();
  });

  it('clamps an out-of-range index onto the queue', () => {
    expect(selectIdsWithinBudget([song('a'), song('b')], 9)).toEqual({ ids: ['a', 'b'], index: 1 });
    expect(selectIdsWithinBudget([song('a'), song('b')], -3)).toEqual({ ids: ['a', 'b'], index: 0 });
  });

  it('keeps what follows the cursor when the queue is too long to fit', () => {
    // 36-char ids ≈ 40 bytes each, so a 1000-track queue is far past the budget.
    const long = Array.from({ length: 1000 }, (_, i) => song(`track-${String(i).padStart(29, '0')}`));
    const selection = selectIdsWithinBudget(long, 0);
    expect(selection).not.toBeNull();
    expect(selection!.ids.length).toBeLessThan(long.length);
    // Starting at the head, the kept run starts at the head too.
    expect(selection!.index).toBe(0);
    expect(selection!.ids[0]).toBe(long[0].id);
  });

  it('keeps the current track at the centre of a long queue', () => {
    const long = Array.from({ length: 1000 }, (_, i) => song(`track-${String(i).padStart(29, '0')}`));
    const selection = selectIdsWithinBudget(long, 500)!;
    expect(selection.ids[selection.index]).toBe(long[500].id);
    // Filled forward first, so more of the queue after the cursor survives.
    expect(selection.ids.length - selection.index).toBeGreaterThan(selection.index);
  });

  it('accounts for the escaped length of an id', () => {
    const wide = Array.from({ length: 400 }, (_, i) => song(`${'ä'.repeat(20)}-${i}`));
    const selection = selectIdsWithinBudget(wide, 0)!;
    // Each 'ä' costs 6 bytes escaped, so far fewer ids fit than the raw length suggests.
    expect(selection.ids.length).toBeLessThan(60);
  });
});

describe('saveQueueToServer', () => {
  it('sends the ids, the cursor and the position in milliseconds', async () => {
    setPlayerQueue(['a', 'b', 'c'], 2, 61.5);
    await expect(saveQueueToServer()).resolves.toBe(true);
    expect(mockSavePlayQueue).toHaveBeenCalledWith({
      ids: ['a', 'b', 'c'],
      currentIndex: 2,
      positionMs: 61500,
    });
  });

  it('does not call the server with an empty queue', async () => {
    await expect(saveQueueToServer()).resolves.toBe(false);
    expect(mockSavePlayQueue).not.toHaveBeenCalled();
  });

  it('treats a missing cursor as the head of the queue', async () => {
    playerStore.setState({ queue: [song('a')], currentTrackIndex: null, position: 0 });
    await saveQueueToServer();
    expect(mockSavePlayQueue.mock.calls[0][0].currentIndex).toBe(0);
  });

  it('reports a rejected save', async () => {
    setPlayerQueue(['a'], 0);
    mockSavePlayQueue.mockResolvedValue(false);
    await expect(saveQueueToServer()).resolves.toBe(false);
  });
});

describe('onTrackChangedForQueueSync', () => {
  it('saves once the configured number of track changes has passed', () => {
    setPlayerQueue(['a', 'b', 'c'], 0);
    onTrackChangedForQueueSync();
    onTrackChangedForQueueSync();
    expect(mockSavePlayQueue).not.toHaveBeenCalled();
    onTrackChangedForQueueSync();
    expect(mockSavePlayQueue).toHaveBeenCalledTimes(1);
  });

  it('saves on every track change at an interval of one', () => {
    setPlayerQueue(['a'], 0);
    playbackSettingsStore.setState({ queueSyncInterval: 1 });
    onTrackChangedForQueueSync();
    onTrackChangedForQueueSync();
    expect(mockSavePlayQueue).toHaveBeenCalledTimes(2);
  });

  it('does nothing while syncing is off', () => {
    setPlayerQueue(['a'], 0);
    playbackSettingsStore.setState({ queueSyncEnabled: false });
    for (let i = 0; i < 5; i++) onTrackChangedForQueueSync();
    expect(mockSavePlayQueue).not.toHaveBeenCalled();
  });

  it('starts counting again once a save has fired', () => {
    setPlayerQueue(['a'], 0);
    playbackSettingsStore.setState({ queueSyncInterval: 3 });
    onTrackChangedForQueueSync();
    onTrackChangedForQueueSync();
    onTrackChangedForQueueSync();
    expect(mockSavePlayQueue).toHaveBeenCalledTimes(1);
    onTrackChangedForQueueSync();
    onTrackChangedForQueueSync();
    expect(mockSavePlayQueue).toHaveBeenCalledTimes(1);
    onTrackChangedForQueueSync();
    expect(mockSavePlayQueue).toHaveBeenCalledTimes(2);
  });

  it('waits out the interval again after a rejected save', async () => {
    setPlayerQueue(['a'], 0);
    playbackSettingsStore.setState({ queueSyncInterval: 3 });
    mockSavePlayQueue.mockResolvedValue(false);
    onTrackChangedForQueueSync();
    onTrackChangedForQueueSync();
    onTrackChangedForQueueSync();
    await Promise.resolve();
    expect(mockSavePlayQueue).toHaveBeenCalledTimes(1);
    // The failure must not turn every following track change into a retry.
    onTrackChangedForQueueSync();
    expect(mockSavePlayQueue).toHaveBeenCalledTimes(1);
  });
});

describe('flushQueueToServer', () => {
  it('saves immediately when syncing is on', () => {
    setPlayerQueue(['a'], 0);
    flushQueueToServer();
    expect(mockSavePlayQueue).toHaveBeenCalledTimes(1);
  });

  it('does nothing while syncing is off', () => {
    setPlayerQueue(['a'], 0);
    playbackSettingsStore.setState({ queueSyncEnabled: false });
    flushQueueToServer();
    expect(mockSavePlayQueue).not.toHaveBeenCalled();
  });
});

describe('fetchServerQueue', () => {
  it('passes the server queue through', async () => {
    const remote = { entry: [song('a')], index: 0, positionMs: 1000 };
    mockGetPlayQueue.mockResolvedValue(remote);
    await expect(fetchServerQueue()).resolves.toBe(remote);
  });

  it('answers null when the server holds none', async () => {
    await expect(fetchServerQueue()).resolves.toBeNull();
  });
});
