/**
 * The single cold-boot chain: migrations → home data → remaining stores → KV.
 *
 * Before this existed the work was split across two call sites that raced:
 * `_layout` hydrated as soon as auth rehydrated (first render), while the splash
 * ran the migrations ~2 s later and hydrated a second time. The first pass
 * therefore read PRE-migration state and every store was hydrated twice.
 *
 * Two gates, one chain:
 *  - {@link whenFirstPaintReady} — migrations + the home carousels. What the
 *    splash waits for.
 *  - {@link ensureBootHydration} — the whole chain. What the startup flow waits
 *    for before `onStartup()`.
 *
 * `headlessMediaService` deliberately does NOT go through here: a CarPlay/Siri
 * cold start has no splash and no migration UI, and it already memoises its own
 * hydration.
 */
import { markBoot } from '../utils/bootTiming';
import { hydrateAlbumListsFromDb } from '../store/albumListsStore';
import { migrationStore } from '../store/migrationStore';
import { awaitKvHydration, rehydrateAllStores } from '../store/persistence/rehydrate';
// Synchronous adapter: `completedVersion` is read before the migration store has
// hydrated, so it must be a synchronous SQLite read.
import { kvStorageSync as kvStorage } from '../store/persistence';
import { getPendingTasks, runMigrations } from './migrationService';

let bootPromise: Promise<void> | null = null;
let firstPaintPromise: Promise<void> | null = null;

const MIGRATION_KEY = 'substreamer-migration';

/** The persisted migration version, read synchronously — the store may not have
 *  hydrated yet, and reading 0 would make every migration look pending. */
function readCompletedVersion(): number {
  try {
    const raw = kvStorage.getItem(MIGRATION_KEY) as string | null;
    if (!raw) return 0;
    return JSON.parse(raw)?.state?.completedVersion ?? 0;
  } catch {
    return 0; // migrations re-run safely
  }
}

/** Whether this launch has migration work to do. Synchronous, so the splash can
 *  decide at mount whether to show the migration UI at all. */
export function hasPendingMigrations(): boolean {
  return getPendingTasks(readCompletedVersion()).length > 0;
}

function start(): void {
  let resolveFirstPaint!: () => void;
  firstPaintPromise = new Promise<void>((resolve) => { resolveFirstPaint = resolve; });

  bootPromise = (async () => {
    try {
      const completedVersion = readCompletedVersion();
      // A no-op when nothing is pending, including the log write.
      const finalVersion = await runMigrations(completedVersion);
      migrationStore.getState().setCompletedVersion(finalVersion);
      markBoot('migrations');
      // The four home carousels, ahead of everything else: they are what the
      // first frame behind the splash renders.
      await hydrateAlbumListsFromDb();
    } finally {
      // Always release the splash. A stage that throws unexpectedly must not
      // leave it hanging until its own timeout.
      markBoot('firstPaintReady');
      resolveFirstPaint();
    }
    // `albumLists` is hydrated a second time in here. That is deliberate: it is
    // four LIMIT-bounded reads, and taking it out of `rehydrateAllStores` would
    // strip it from the headless CarPlay/Siri path, which calls that function
    // directly and reads `albumListsStore`.
    await rehydrateAllStores();
    markBoot('rehydrateStores');
    await awaitKvHydration();
    markBoot('bootReady');
  })();
}

/**
 * Resolve once migrations have run and the home carousels are hydrated — the
 * point at which the UI behind the splash renders real content.
 */
export function whenFirstPaintReady(): Promise<void> {
  if (!firstPaintPromise) start();
  return firstPaintPromise!;
}

/**
 * Resolve once the whole boot chain is done: migrations, every per-row store and
 * the startup-critical KV stores. Idempotent — the chain runs once per session.
 */
export function ensureBootHydration(): Promise<void> {
  if (!bootPromise) start();
  return bootPromise!;
}

/**
 * Drop the memoised chain so the next login hydrates again. Called from
 * `resetAllStores` on logout.
 */
export function resetBootHydration(): void {
  bootPromise = null;
  firstPaintPromise = null;
}
