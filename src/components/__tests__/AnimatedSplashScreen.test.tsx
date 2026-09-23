import React from 'react';
import { render, act } from '@testing-library/react-native';

// Stubs for the per-row SQLite path + the imageCacheService that the store graph
// transitively imports for cover-art prefetching. These don't touch the splash's
// own logic — the splash just needs the hydration calls to be no-ops.
jest.mock('../../services/imageCacheService', () => ({
  ensureCached: jest.fn(),
  prefetchCoverArt: jest.fn(),
  subscribeImageQueueChanges: jest.fn(() => () => {}),
  getImageQueueState: jest.fn(() => ({
    cycleId: null,
    cycleScope: null,
    cycleTotal: 0,
    processed: 0,
    failed: 0,
    isPaused: false,
  })),
  processImageQueue: jest.fn(async () => {}),
  recoverStalledImageDownloads: jest.fn(async () => {}),
}));

/* ------------------------------------------------------------------ */
/*  Capture the animate() callback from BootSplash.useHideAnimation    */
/* ------------------------------------------------------------------ */

let capturedAnimate: (() => void) | null = null;

jest.mock('react-native-bootsplash', () => ({
  __esModule: true,
  default: {
    useHideAnimation: (config: { animate: () => void }) => {
      capturedAnimate = config.animate;
      return {
        container: { style: { flex: 1, backgroundColor: '#1D9BF0' }, onLayout: () => {} },
        logo: { source: 1, style: { width: 130, height: 130 } },
      };
    },
    hide: () => Promise.resolve(),
    isVisible: () => false,
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

/* ------------------------------------------------------------------ */
/*  Track withTiming callbacks so the fade-out completion can be fired  */
/* ------------------------------------------------------------------ */

const pendingCallbacks: Array<(finished: boolean) => void> = [];

jest.mock('react-native-reanimated', () => {
  const { View, Image } = require('react-native');

  const AnimatedView = View;
  const AnimatedImage = Image;
  const AnimatedText = require('react-native').Text;

  return {
    __esModule: true,
    default: { View: AnimatedView, Image: AnimatedImage, Text: AnimatedText },
    useSharedValue: (init: number) => ({ value: init }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (val: number, _config?: object, cb?: (finished: boolean) => void) => {
      if (cb) pendingCallbacks.push(cb);
      return val;
    },
    withSpring: (val: number) => val,
    withDelay: (_ms: number, val: any) => val,
    withRepeat: (val: any) => val,
    withSequence: (...args: any[]) => args[args.length - 1],
    cancelAnimation: () => {},
    Easing: {
      out: (e: any) => e,
      in: (e: any) => e,
      inOut: (e: any) => e,
      cubic: (t: number) => t,
      sin: (t: number) => t,
    },
    runOnJS: (fn: Function) => fn,
  };
});

/* ------------------------------------------------------------------ */
/*  Boot sequence mock — per-test overridable                          */
/* ------------------------------------------------------------------ */

let mockHasPendingMigrations = false;
/** Resolves the first-paint gate; a test controls when boot is "ready". */
let releaseFirstPaint: () => void = () => {};
let mockFirstPaint: Promise<void>;

const mockEnsureBootHydration = jest.fn(() => Promise.resolve());

jest.mock('../../services/bootSequence', () => ({
  ensureBootHydration: () => mockEnsureBootHydration(),
  whenFirstPaintReady: () => mockFirstPaint,
  hasPendingMigrations: () => mockHasPendingMigrations,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AnimatedSplashScreen = require('../AnimatedSplashScreen').default;

beforeEach(() => {
  capturedAnimate = null;
  pendingCallbacks.length = 0;
  mockHasPendingMigrations = false;
  mockEnsureBootHydration.mockClear();
  mockFirstPaint = new Promise<void>((resolve) => { releaseFirstPaint = resolve; });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Fire the most recent withTiming callback (the container fade-out completing). */
function fireLastCallback() {
  const cb = pendingCallbacks.pop();
  if (cb) cb(true);
}

/** Trigger BootSplash's animate() — the native → JS handoff. */
function handOff() {
  expect(capturedAnimate).not.toBeNull();
  capturedAnimate!();
}

/** Resolve the first-paint gate and let the promise continuation run. */
async function bootReady() {
  releaseFirstPaint();
  await act(async () => { await Promise.resolve(); });
}

/** Walk past the min-visible floor and complete the fade. */
function finishFade() {
  act(() => { jest.advanceTimersByTime(400); });
  act(() => { fireLastCallback(); });
}

describe('AnimatedSplashScreen', () => {
  /* ---------------------------------------------------------------- */
  /*  Readiness-driven fade                                            */
  /* ---------------------------------------------------------------- */

  describe('readiness gate', () => {
    it('starts the boot chain on mount', () => {
      render(<AnimatedSplashScreen onFinish={jest.fn()} />);
      expect(mockEnsureBootHydration).toHaveBeenCalledTimes(1);
    });

    it('fades out once boot is ready, without waiting for the waveform', async () => {
      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      act(() => { handOff(); });
      await bootReady();

      expect(onFinish).not.toHaveBeenCalled(); // still inside the min-visible floor
      finishFade();

      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('does not fade before the native splash has handed over', async () => {
      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      // Boot wins the race — but BootSplash still owns the screen.
      await bootReady();
      act(() => { jest.advanceTimersByTime(2_000); });
      act(() => { fireLastCallback(); });

      expect(onFinish).not.toHaveBeenCalled();
    });

    it('fades once the handoff arrives after boot was already ready', async () => {
      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      await bootReady();
      act(() => { handOff(); });
      finishFade();

      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('holds the splash for the min-visible floor after the handoff', async () => {
      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      act(() => { handOff(); });
      await bootReady();

      // Not yet: the floor has not elapsed, so doFadeOut has not been scheduled.
      act(() => { jest.advanceTimersByTime(399); });
      act(() => { fireLastCallback(); });
      expect(onFinish).not.toHaveBeenCalled();

      act(() => { jest.advanceTimersByTime(1); });
      act(() => { fireLastCallback(); });
      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('fades out at the cap when boot never becomes ready', () => {
      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      act(() => { handOff(); });
      // Never resolve mockFirstPaint — the cap must release the splash anyway.
      act(() => { jest.advanceTimersByTime(2_500); });
      finishFade();

      expect(onFinish).toHaveBeenCalledTimes(1);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Safety timeout                                                   */
  /* ---------------------------------------------------------------- */

  describe('safety timeout', () => {
    it('calls onFinish if nothing else completes', () => {
      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      act(() => { jest.advanceTimersByTime(15_000); });

      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('does not double-call onFinish after a normal fade', async () => {
      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      act(() => { handOff(); });
      await bootReady();
      finishFade();

      expect(onFinish).toHaveBeenCalledTimes(1);

      act(() => { jest.advanceTimersByTime(15_000); });

      expect(onFinish).toHaveBeenCalledTimes(1);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Migration flow                                                   */
  /* ---------------------------------------------------------------- */

  describe('migration flow', () => {
    it('shows the migration status text when tasks are pending', () => {
      mockHasPendingMigrations = true;

      const { getByText } = render(<AnimatedSplashScreen onFinish={jest.fn()} />);

      // The status area is mounted from the start, not after an animation.
      expect(getByText('Starting up')).toBeTruthy();
      expect(getByText('Running Migrations')).toBeTruthy();
    });

    it('runs the done transition before fading when migrations were shown', async () => {
      mockHasPendingMigrations = true;

      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      act(() => { handOff(); });
      await bootReady();

      // The done transition holds for 1200ms before fading — the plain path
      // would already have faded by now.
      act(() => { jest.advanceTimersByTime(400); });
      act(() => { fireLastCallback(); });
      expect(onFinish).not.toHaveBeenCalled();

      act(() => { jest.advanceTimersByTime(1_200); });
      finishFade();

      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('fades straight out when nothing is pending', async () => {
      mockHasPendingMigrations = false;

      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      act(() => { handOff(); });
      await bootReady();
      finishFade();

      expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('still finishes when the boot chain rejects', async () => {
      const onFinish = jest.fn();
      mockFirstPaint = Promise.reject(new Error('boom'));
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      act(() => { handOff(); });
      await act(async () => { await Promise.resolve(); });
      finishFade();

      expect(onFinish).toHaveBeenCalledTimes(1);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  Fade-out edge cases                                              */
  /* ---------------------------------------------------------------- */

  describe('fade-out edge cases', () => {
    it('ignores a fade callback that reports finished=false', async () => {
      const onFinish = jest.fn();
      render(<AnimatedSplashScreen onFinish={onFinish} />);

      act(() => { handOff(); });
      await bootReady();
      act(() => { jest.advanceTimersByTime(400); });

      act(() => {
        const cb = pendingCallbacks.pop();
        if (cb) cb(false);
      });

      expect(onFinish).not.toHaveBeenCalled();
    });
  });
});
