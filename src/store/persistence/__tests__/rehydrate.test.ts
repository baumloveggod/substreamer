/**
 * `awaitKvHydration` — the boot gate that holds the startup chain until every
 * async-persisted startup store has loaded. Driven through a REAL store's real
 * `persist` API rather than a stub, because the whole point is the timing:
 * `rehydrate()` flips `hasHydrated` false synchronously and resolves a microtask
 * later, which is the window the gate exists to cover.
 */
import { completedScrobbleStore } from '../../completedScrobbleStore';
import { genreStore } from '../../genreStore';
import { awaitKvHydration, rehydrateAllStores } from '../rehydrate';

describe('awaitKvHydration', () => {
  it('resolves immediately once every store has already hydrated', async () => {
    await awaitKvHydration();
    expect(genreStore.persist.hasHydrated()).toBe(true);
    await expect(awaitKvHydration()).resolves.toBeUndefined();
  });

  it('waits for a store that is still hydrating', async () => {
    await awaitKvHydration(); // settle whatever the import kicked off
    void genreStore.persist.rehydrate();
    expect(genreStore.persist.hasHydrated()).toBe(false);

    await awaitKvHydration();

    expect(genreStore.persist.hasHydrated()).toBe(true);
  });
});

/**
 * `rehydrateAllStores` gates boot, so what it does NOT hydrate matters as much as
 * what it does. `completedScrobbleStore` runs seven aggregate queries over
 * `scrobble_events`, most of them full scans; it feeds the home stat tiles and My
 * Listening, neither first-paint critical, so `runDeferredStartup` hydrates it in
 * an idle window instead.
 */
describe('rehydrateAllStores', () => {
  it('does not hydrate the listening analytics', async () => {
    const spy = jest.spyOn(completedScrobbleStore.getState(), 'hydrateFromDbAsync');

    const result = await rehydrateAllStores();

    expect(spy).not.toHaveBeenCalled();
    expect(result.succeeded).not.toContain('completedScrobble');
    spy.mockRestore();
  });

  it('still hydrates the stores the startup flow and CarPlay read', async () => {
    const result = await rehydrateAllStores();

    // albumLists stays in here on purpose: headlessMediaService calls this
    // function directly for the CarPlay/Siri cold start and reads albumListsStore.
    expect(result.succeeded).toEqual(
      expect.arrayContaining(['albumLists', 'favorites', 'musicCache']),
    );
  });
});
