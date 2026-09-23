/**
 * Startup markers for cold-boot profiling.
 *
 * `console.*` is stripped from release builds (see babel.config.js), and the
 * numbers that matter are the release ones — so the marks are kept in memory and
 * rendered by the Logging screen instead of logged.
 *
 * No imports: this is required from `index.js` before anything else, where a
 * throw would take the bundle down before any error boundary exists.
 *
 * Marks are recorded once per process and never reset. A cap keeps a runaway
 * caller from growing the array without bound.
 */

/** Recorded marks, in call order. The first one is the start of the timeline. */
const marks: Array<{ name: string; at: number }> = [];

const MAX_MARKS = 32;

/** Record a boot milestone. No-op once {@link MAX_MARKS} have been recorded. */
export function markBoot(name: string): void {
  if (marks.length >= MAX_MARKS) return;
  marks.push({ name, at: Date.now() });
}

export interface BootTiming {
  name: string;
  /** ms since the first recorded mark. */
  sinceStartMs: number;
  /** ms since the previous mark (0 for the first). */
  deltaMs: number;
}

/** The recorded marks as cumulative + per-step durations. Empty before boot. */
export function getBootTimings(): BootTiming[] {
  if (marks.length === 0) return [];
  const start = marks[0].at;
  return marks.map((m, i) => ({
    name: m.name,
    sinceStartMs: m.at - start,
    deltaMs: i === 0 ? 0 : m.at - marks[i - 1].at,
  }));
}
