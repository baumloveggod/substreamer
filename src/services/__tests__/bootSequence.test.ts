/**
 * The cold-boot chain. What matters here is ORDER and ONCE-NESS: migrations must
 * land before anything hydrates, the first-paint gate must open before the slow
 * tail, and two callers must not produce two runs. Before this module existed,
 * `_layout` and the splash each ran their own chain and raced.
 */

const order: string[] = [];

let mockPendingTasks: Array<{ id: number }> = [];
const mockRunMigrations = jest.fn(async (completed: number) => {
  order.push('migrations');
  return completed;
});

jest.mock('../migrationService', () => ({
  getPendingTasks: () => mockPendingTasks,
  runMigrations: (completed: number) => mockRunMigrations(completed),
}));

const mockHydrateAlbumLists = jest.fn(async () => { order.push('albumLists'); });
jest.mock('../../store/albumListsStore', () => ({
  hydrateAlbumListsFromDb: () => mockHydrateAlbumLists(),
}));

const mockRehydrateAllStores = jest.fn(async () => {
  order.push('rehydrateAllStores');
  return { succeeded: [], failed: [] };
});
const mockAwaitKvHydration = jest.fn(async () => { order.push('awaitKvHydration'); });
jest.mock('../../store/persistence/rehydrate', () => ({
  rehydrateAllStores: () => mockRehydrateAllStores(),
  awaitKvHydration: () => mockAwaitKvHydration(),
}));

const mockSetCompletedVersion = jest.fn();
jest.mock('../../store/migrationStore', () => ({
  migrationStore: { getState: () => ({ setCompletedVersion: mockSetCompletedVersion }) },
}));

let mockKvValue: string | null = null;
jest.mock('../../store/persistence', () => ({
  kvStorageSync: { getItem: () => mockKvValue },
}));

import {
  ensureBootHydration,
  hasPendingMigrations,
  resetBootHydration,
  whenFirstPaintReady,
} from '../bootSequence';

beforeEach(() => {
  order.length = 0;
  mockPendingTasks = [];
  mockKvValue = null;
  mockRunMigrations.mockClear();
  mockHydrateAlbumLists.mockClear();
  mockRehydrateAllStores.mockClear();
  mockAwaitKvHydration.mockClear();
  mockSetCompletedVersion.mockClear();
  resetBootHydration();
});

describe('ensureBootHydration', () => {
  it('runs migrations before any store hydration', async () => {
    await ensureBootHydration();

    expect(order).toEqual([
      'migrations',
      'albumLists',
      'rehydrateAllStores',
      'awaitKvHydration',
    ]);
  });

  it('persists the version the migration run returned', async () => {
    mockRunMigrations.mockImplementationOnce(async () => { order.push('migrations'); return 42; });

    await ensureBootHydration();

    expect(mockSetCompletedVersion).toHaveBeenCalledWith(42);
  });

  it('collapses concurrent callers into a single run', async () => {
    await Promise.all([ensureBootHydration(), ensureBootHydration(), ensureBootHydration()]);

    expect(mockRunMigrations).toHaveBeenCalledTimes(1);
    expect(mockRehydrateAllStores).toHaveBeenCalledTimes(1);
  });

  it('is a no-op await once it has already completed', async () => {
    await ensureBootHydration();
    await ensureBootHydration();

    expect(mockRehydrateAllStores).toHaveBeenCalledTimes(1);
  });

  it('runs again after resetBootHydration, so a new login rehydrates', async () => {
    await ensureBootHydration();
    resetBootHydration();
    await ensureBootHydration();

    expect(mockRehydrateAllStores).toHaveBeenCalledTimes(2);
  });

  it('shares one chain with whenFirstPaintReady', async () => {
    void whenFirstPaintReady();
    await ensureBootHydration();

    expect(mockRunMigrations).toHaveBeenCalledTimes(1);
  });
});

describe('whenFirstPaintReady', () => {
  it('opens once migrations and the home carousels are done, before the slow tail', async () => {
    let resolveRehydrate!: () => void;
    mockRehydrateAllStores.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveRehydrate = () => { order.push('rehydrateAllStores'); resolve({ succeeded: [], failed: [] }); };
      }),
    );

    void ensureBootHydration();
    await whenFirstPaintReady();

    // The gate is open while the remaining stores are still in flight.
    expect(order).toEqual(['migrations', 'albumLists']);
    resolveRehydrate();
  });

  it('opens even when a boot stage throws, so the splash cannot hang', async () => {
    mockHydrateAlbumLists.mockImplementationOnce(async () => { throw new Error('boom'); });

    void ensureBootHydration().catch(() => { /* surfaced to the caller, not our concern */ });

    await expect(whenFirstPaintReady()).resolves.toBeUndefined();
  });
});

describe('hasPendingMigrations', () => {
  it('is false when the task list is empty', () => {
    mockPendingTasks = [];
    expect(hasPendingMigrations()).toBe(false);
  });

  it('is true when tasks are pending', () => {
    mockPendingTasks = [{ id: 1 }];
    expect(hasPendingMigrations()).toBe(true);
  });

  it('reads the persisted version synchronously rather than from the store', () => {
    mockKvValue = JSON.stringify({ state: { completedVersion: 7 } });
    mockPendingTasks = [];

    hasPendingMigrations();

    // Proven through the chain: the same read feeds runMigrations.
    return ensureBootHydration().then(() => {
      expect(mockRunMigrations).toHaveBeenCalledWith(7);
    });
  });

  it('falls back to version 0 on unparseable persisted state', async () => {
    mockKvValue = 'not json';

    await ensureBootHydration();

    expect(mockRunMigrations).toHaveBeenCalledWith(0);
  });
});
