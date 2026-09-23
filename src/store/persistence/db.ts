/**
 * Central SQLite persistence service.
 *
 * Owns the single DB connection (`openDbConnection` in `@/db/client`, which applies
 * the PRAGMAs), the boot-time one-time heals, schema creation for every table the
 * app uses, health reporting, and the test-injection hook. Every other module in
 * `src/store/persistence/` (the Zustand StateStorage adapter + the row-table query
 * helpers) pulls its handle from `getDb()` instead of opening its own.
 *
 * One module rather than one per consumer, because:
 * - Schema CREATEs run in explicit source order here, so FK-dependent tables are
 *   created after their parents instead of in import-graph order.
 * - Init-failure handling lives in one place. The KV-blob adapter (`kvStorage.ts`)
 *   falls back to an in-memory Map so the UI can render; row-table modules become
 *   safe no-ops. Both paths read the same `dbHealthy` / `dbInitError` here.
 *
 * Tests: call `__setDbForTests(fake)` to swap the handle.
 */
import { openDbConnection, type InternalDb } from '@/db/client';
import {
  ensureNormalizedSchemaIfChanged,
  normalizedSchemaNeedsUpdate,
} from '@/db/createNormalizedTables';
import { markBoot } from '@/utils/bootTiming';

// The DB surface types (`InternalDb`, `RunResult`) live in the op-SQLite client;
// re-exported here so consumers can import them from either module.
export type { BatchCommand, InternalDb, RunResult } from '@/db/client';

let db: InternalDb | null = null;
let initError: Error | null = null;

/**
 * In-memory fallback for the KV (blob) storage when the DB is unavailable.
 * Used only by `kvStorage.ts`. Row-table modules refuse writes when the
 * DB is null rather than falling back (row data silently going to memory is
 * worse than not writing at all).
 */
export const kvFallback = new Map<string, string>();

try {
  // Open op-SQLite on the existing file, apply PRAGMAs, and log the boot
  // diagnostic (engine + resolved path). See src/db/client.ts.
  const conn = openDbConnection();
  db = conn.db;

  // The one-time heals below and the schema pass run ONLY when the DDL fingerprint
  // has moved. Both heals repair duplicates that predate the UNIQUE indexes the same
  // DDL creates (idx_cached_item_songs_item_song, idx_download_queue_position_unique);
  // once those exist, SQLite rejects a duplicate at write time and there is nothing
  // left to heal. Every existing install starts at user_version 0, so each runs once
  // more after this lands and is then done.
  if (normalizedSchemaNeedsUpdate(db)) {
    // cached_item_songs dedup. It must run BEFORE the UNIQUE (item_id, song_id) index,
    // which `ensureNormalizedSchemaIfChanged` creates inside a single all-or-nothing
    // transaction below: surviving duplicates would fail that CREATE and take DB init
    // down. The PK (item_id, position) prevents a duplicate insert at the same position
    // but not the same song at two positions, which a concurrent `ensurePartialAlbumEdge`
    // + queue-completion race could produce. Guarded on the table existing — a fresh
    // install has not created it yet (and it can hold no duplicates).
    const itemSongsTable = db.getFirstSync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='cached_item_songs'",
    );
    if ((itemSongsTable?.n ?? 0) > 0) {
      db.execSync(
        `DELETE FROM cached_item_songs
           WHERE rowid NOT IN (
             SELECT MIN(rowid) FROM cached_item_songs
             GROUP BY item_id, song_id
           );`,
      );
    }

    // The superseded non-unique position index. `CREATE UNIQUE INDEX IF NOT EXISTS`
    // under the same name is a no-op, so the constraint below arrives under a new
    // name and this one is retired here (same pattern as idx_song_index_title).
    db.execSync('DROP INDEX IF EXISTS idx_download_queue_position;');

    // download_queue position renumber — same ordering requirement as the dedup above:
    // it must run BEFORE the UNIQUE (queue_position) index, or surviving duplicates fail
    // that CREATE and null the whole DB handle. Duplicates are possible on every install
    // predating the constraint — the slot was a JS-computed MAX+1 over an in-memory
    // mirror, which reads 0 for an enqueue that beats `hydrateFromDbAsync`. Rows are
    // RENUMBERED, never deleted: each duplicate is a real queued download.
    const queueTable = db.getFirstSync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='download_queue'",
    );
    if ((queueTable?.n ?? 0) > 0) {
      const duplicates = db.getFirstSync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (
           SELECT queue_position FROM download_queue
            GROUP BY queue_position HAVING COUNT(*) > 1 LIMIT 1
         )`,
      );
      if ((duplicates?.n ?? 0) > 0) {
        // `conn.db`, not `db`: the mutable module binding loses its non-null
        // narrowing inside the callback.
        conn.db.withTransactionSync(() => {
          // Dense 1..N in (queue_position, added_at, queue_id) order — deterministic,
          // so two devices repairing the same queue agree. Written NEGATED first: a
          // positive target can collide with a row that has not been renumbered yet,
          // and negative space is disjoint from every untouched row.
          conn.db.execSync(
            `UPDATE download_queue SET queue_position = -ranked.rn
               FROM (SELECT queue_id,
                            ROW_NUMBER() OVER (ORDER BY queue_position, added_at, queue_id) AS rn
                       FROM download_queue) AS ranked
              WHERE ranked.queue_id = download_queue.queue_id;`,
          );
          conn.db.execSync(
            'UPDATE download_queue SET queue_position = -queue_position WHERE queue_position < 0;',
          );
        });
      }
    }
  }

  markBoot('dbHeals');

  // Normalized model: create the songs/albums/artists/playlists tables + children at
  // boot so the live sync can dual-write them (not just the one-time migration).
  // Generated DDL, all CREATE ... IF NOT EXISTS — idempotent + FK-safe. Gated on the
  // DDL fingerprint (PRAGMA user_version): a no-op pass is ~211 synchronous round trips.
  ensureNormalizedSchemaIfChanged(db);
  markBoot('schemaEnsure');
} catch (e) {
  db = null;
  initError = e instanceof Error ? e : new Error(String(e));
  // eslint-disable-next-line no-console
  console.warn(
    '[persistence/db] init failed; SQLite unavailable, KV falls back to memory, row tables refuse writes:',
    initError.message,
  );
}

/** Shared handle accessor. Returns null when the DB failed to open. */
export function getDb(): InternalDb | null {
  return db;
}

/**
 * True when the SQLite-backing store is currently available.
 *
 * A function, not a const captured at module load, so callers see live state — both
 * for the runtime swap via `__setDbForTests` and because destructured ESM-import
 * bindings under our CommonJS-style test transpile are otherwise frozen at first
 * import. In production the handle is opened once and never reassigned.
 */
export function isDbHealthy(): boolean {
  return db !== null;
}

/** The error captured at init time, or null on success. */
export const dbInitError: Error | null = initError;

/**
 * Test-only: swap the shared handle. The single injection point for every
 * persistence module.
 */
export function __setDbForTests(fake: InternalDb | null): void {
  db = fake;
}
