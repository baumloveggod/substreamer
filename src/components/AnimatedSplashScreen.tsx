import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import BootSplash from 'react-native-bootsplash';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import AnimatedWaveformLogo, { type WaveformHandle } from './AnimatedWaveformLogo';
import {
  ensureBootHydration,
  hasPendingMigrations,
  whenFirstPaintReady,
} from '../services/bootSequence';
import { markBoot } from '../utils/bootTiming';

/**
 * Max time (ms) before we force-finish, even if an animation or
 * migration task stalls. Increased from 5 s to accommodate migrations.
 */
const SAFETY_TIMEOUT = 15_000;

/**
 * Minimum time (ms) the splash stays visible after the native splash is
 * dismissed. Short on purpose: it only exists so a very fast boot doesn't
 * flash the splash in and straight back out.
 */
const MIN_VISIBLE_MS = 400;

/** Fade-out duration (ms). */
const FADE_MS = 250;

/**
 * Cap (ms) on waiting for the boot chain. The splash covers the app, so a slow
 * hydration must not hold the UI hostage — past this we fade out and let the
 * stores populate reactively behind the user.
 */
const READY_CAP_MS = 2_500;

/**
 * Scale of native splash logo content vs container. Must match logoScale (0.80)
 * in scripts/generate-assets.js for splash-logo.svg. If that changes, update here.
 */
const NATIVE_CONTENT_SCALE = 0.8;

const DOT_SIZE = 8;
const DOT_GAP = 10;

type MigrationPhase = 'idle' | 'running' | 'done';

type Props = {
  onFinish: () => void;
};

export default function AnimatedSplashScreen({ onFinish }: Props) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const containerOpacity = useSharedValue(1);
  const logoImageOpacity = useSharedValue(1);
  const animatedLogoOpacity = useSharedValue(0);
  const logoContentScale = useSharedValue(NATIVE_CONTENT_SCALE);
  const logoScale = useSharedValue(1);
  const logoTranslateY = useSharedValue(0);

  // Status area shared values
  const statusOpacity = useSharedValue(0);
  const dot0Scale = useSharedValue(0.4);
  const dot1Scale = useSharedValue(0.4);
  const dot2Scale = useSharedValue(0.4);
  const dotsOpacity = useSharedValue(1);
  const dotsScale = useSharedValue(1);
  const checkOpacity = useSharedValue(0);
  const checkScale = useSharedValue(0.3);
  const validatingOpacity = useSharedValue(1);
  const completeOpacity = useSharedValue(0);

  const onFinishRef = useRef(onFinish);
  const didFinish = useRef(false);
  /** Set once bootsplash's `animate()` has handed over. Nothing may fade before
   *  then, or the native splash is still the thing on screen. */
  const handoffDone = useRef(false);
  /** Set once the boot chain (or the cap) says we may go, so a handoff arriving
   *  second still triggers the fade. */
  const readyToFade = useRef(false);
  const visibleSince = useRef(0);
  const [migrationPhase, setMigrationPhase] = useState<MigrationPhase>(
    // Decided synchronously at mount: with migrations pending the status UI is
    // shown from the start rather than after an animation that is no longer a gate.
    () => (hasPendingMigrations() ? 'running' : 'idle'),
  );
  // Imperative handle: the ripple sequence only arms when bootsplash's
  // `animate()` callback fires. Otherwise the forward sweep plays while
  // animatedLogoOpacity is still 0 and the user only sees the reverse sweep.
  const waveformRef = useRef<WaveformHandle>(null);
  onFinishRef.current = onFinish;

  const complete = useCallback(() => {
    if (!didFinish.current) {
      didFinish.current = true;
      markBoot('splashHidden');
      onFinishRef.current();
    }
  }, []);

  const doFadeOut = useCallback(() => {
    containerOpacity.value = withTiming(
      0,
      { duration: FADE_MS, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(complete)();
      },
    );
  }, [containerOpacity, complete]);

  const fadeOut = useCallback(() => {
    readyToFade.current = true;
    // BootSplash still owns the screen until `animate()` fires. Fading before
    // that breaks its native → JS handoff; `animate()` calls back in here.
    if (!handoffDone.current) return;
    const elapsed = Date.now() - visibleSince.current;
    const remaining = MIN_VISIBLE_MS - elapsed;
    if (remaining > 0) {
      setTimeout(doFadeOut, remaining);
    } else {
      doFadeOut();
    }
  }, [doFadeOut]);

  const startBreathingDots = useCallback(() => {
    const breathe = withRepeat(
      withSequence(
        withTiming(1, { duration: 400, easing: Easing.inOut(Easing.sin) }),
        withTiming(0.4, { duration: 400, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      false,
    );

    dot0Scale.value = breathe;
    dot1Scale.value = withDelay(150, breathe);
    dot2Scale.value = withDelay(300, breathe);
  }, [dot0Scale, dot1Scale, dot2Scale]);

  // Drive the boot chain and fade as soon as it says the first frame is real.
  // The waveform below is decoration now, not the gate: a settled install used to
  // sit here for ~2.4 s of fixed choreography with nothing left to wait for.
  const migrationPhaseRef = useRef(migrationPhase);
  migrationPhaseRef.current = migrationPhase;
  const fadeOutRef = useRef(fadeOut);
  fadeOutRef.current = fadeOut;
  // A ref, not an effect-local flag: the release must survive re-renders. Held in a
  // local, a re-armed effect would release a second time — and by then the phase has
  // already moved to 'done', so the second release skips the migration hold.
  const releasedRef = useRef(false);
  useEffect(() => {
    void ensureBootHydration();
    const release = () => {
      if (releasedRef.current) return;
      releasedRef.current = true;
      // With migrations on screen, hand over to the done-transition effect so the
      // checkmark and its hold still play. Otherwise fade straight out.
      if (migrationPhaseRef.current === 'running') setMigrationPhase('done');
      else fadeOutRef.current();
    };
    const capTimer = setTimeout(release, READY_CAP_MS);
    void whenFirstPaintReady().then(release).catch(release);
    return () => clearTimeout(capTimer);
    // Mount-only by design: a one-shot boot driver must never re-arm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Done transition: dots → checkmark, text cross-fade, then fadeOut
  useEffect(() => {
    if (migrationPhase !== 'done') return;

    // Cancel breathing dots
    cancelAnimation(dot0Scale);
    cancelAnimation(dot1Scale);
    cancelAnimation(dot2Scale);

    // Dots shrink + fade out
    dotsOpacity.value = withTiming(0, { duration: 300 });
    dotsScale.value = withTiming(0.6, { duration: 300 });

    // Checkmark pops in with spring after 150ms overlap
    checkOpacity.value = withDelay(
      150,
      withTiming(1, { duration: 300 }),
    );
    checkScale.value = withDelay(
      150,
      withSpring(1, { damping: 12, stiffness: 180 }),
    );

    // Text cross-fade
    validatingOpacity.value = withTiming(0, { duration: 250 });
    completeOpacity.value = withDelay(
      200,
      withTiming(1, { duration: 250 }),
    );

    // Hold then fade out
    const timeout = setTimeout(() => {
      fadeOut();
    }, 1200);

    return () => clearTimeout(timeout);
  }, [migrationPhase, dot0Scale, dot1Scale, dot2Scale, dotsOpacity, dotsScale, checkOpacity, checkScale, validatingOpacity, completeOpacity, fadeOut]);

  // Migration UI, armed at mount rather than after the ripple: the phase is decided
  // synchronously by `hasPendingMigrations()`, so there is nothing to wait for.
  useEffect(() => {
    if (migrationPhase !== 'running') return;
    logoScale.value = withSpring(0.6);
    logoTranslateY.value = withSpring(-60);
    statusOpacity.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) });
    startBreathingDots();
    // Fires exactly once: 'running' is only ever left for 'done', which returns early.
  }, [migrationPhase, logoScale, logoTranslateY, statusOpacity, startBreathingDots]);

  const { container, logo } = BootSplash.useHideAnimation({
    manifest: require('../../assets/bootsplash/manifest.json'),
    logo: require('../../assets/bootsplash/logo.png'),

    animate: () => {
      visibleSince.current = Date.now();
      handoffDone.current = true;
      markBoot('splashHandoff');
      logoImageOpacity.value = 0;
      animatedLogoOpacity.value = 1;
      logoContentScale.value = withTiming(
        1,
        { duration: 300, easing: Easing.out(Easing.cubic) },
      );
      // The boot chain can finish before the native splash hands over — on a warm
      // start it routinely does. `fadeOut` bailed then; run it now.
      if (readyToFade.current) fadeOut();
      // Mount-time animation start is the wrong trigger here: the bootsplash
      // keeps the waveform invisible until this callback fires, so kick off
      // the ripple sweeps NOW to keep the forward sweep on-screen.
      waveformRef.current?.start();
    },
  });

  // Safety timeout
  useEffect(() => {
    const timeout = setTimeout(complete, SAFETY_TIMEOUT);
    return () => clearTimeout(timeout);
  }, [complete]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: containerOpacity.value,
  }));

  const logoWrapStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: logoScale.value },
      { translateY: logoTranslateY.value },
    ],
  }));

  const logoImageStyle = useAnimatedStyle(() => ({
    opacity: logoImageOpacity.value,
  }));

  const animatedLogoStyle = useAnimatedStyle(() => ({
    opacity: animatedLogoOpacity.value,
    transform: [{ scale: logoContentScale.value }],
  }));

  const statusStyle = useAnimatedStyle(() => ({
    opacity: statusOpacity.value,
  }));

  const dotsContainerStyle = useAnimatedStyle(() => ({
    opacity: dotsOpacity.value,
    transform: [{ scale: dotsScale.value }],
  }));

  const dot0Style = useAnimatedStyle(() => ({
    transform: [{ scale: dot0Scale.value }],
  }));

  const dot1Style = useAnimatedStyle(() => ({
    transform: [{ scale: dot1Scale.value }],
  }));

  const dot2Style = useAnimatedStyle(() => ({
    transform: [{ scale: dot2Scale.value }],
  }));

  const checkStyle = useAnimatedStyle(() => ({
    opacity: checkOpacity.value,
    transform: [{ scale: checkScale.value }],
  }));

  const validatingStyle = useAnimatedStyle(() => ({
    opacity: validatingOpacity.value,
  }));

  const completeStyle = useAnimatedStyle(() => ({
    opacity: completeOpacity.value,
  }));

  const statusBottom = Math.max(insets.bottom, 24) + 40;

  return (
    <Animated.View
      {...container}
      style={[container.style, containerStyle]}
    >
      <Animated.View
        style={[styles.logoWrap, logoWrapStyle]}
      >
        {/* Static bootsplash logo Image – visible until animate() fires */}
        <Animated.Image
          {...logo}
          style={[logo.style, { position: 'absolute' as const }, logoImageStyle]}
        />

        {/* Animated waveform bars – hidden until animate() swaps them in */}
        <Animated.View style={animatedLogoStyle}>
          <AnimatedWaveformLogo
            ref={waveformRef}
            size={130}
            color="#FFFFFF"
            autoStart={false}
          />
        </Animated.View>
      </Animated.View>

      {/* Status area — bottom-aligned */}
      <Animated.View
        style={[styles.statusWrap, { bottom: statusBottom }, statusStyle]}
        pointerEvents="none"
      >
        <Text style={styles.titleText}>{t('startingUp')}</Text>

        {/* Indicator row — fixed height for dots/checkmark swap */}
        <View style={styles.indicatorRow}>
          <Animated.View style={[styles.dotsRow, dotsContainerStyle]}>
            <Animated.View style={[styles.dot, dot0Style]} />
            <Animated.View style={[styles.dot, dot1Style]} />
            <Animated.View style={[styles.dot, dot2Style]} />
          </Animated.View>
          <Animated.View style={[styles.checkWrap, checkStyle]}>
            <Ionicons name="checkmark" size={24} color="#FFFFFF" />
          </Animated.View>
        </View>

        {/* Subtitle row — fixed height for text cross-fade */}
        <View style={styles.subtitleRow}>
          <Animated.Text style={[styles.subtitleText, styles.subtitleAbsolute, validatingStyle]}>
            {t('migrationValidating')}
          </Animated.Text>
          <Animated.Text style={[styles.subtitleText, styles.subtitleAbsolute, completeStyle]}>
            {t('migrationComplete')}
          </Animated.Text>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  logoWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  titleText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 12,
  },
  indicatorRow: {
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dotsRow: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: DOT_GAP,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: '#FFFFFF',
  },
  checkWrap: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitleRow: {
    height: 20,
    marginTop: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  subtitleText: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 14,
    fontWeight: '500',
  },
  subtitleAbsolute: {
    position: 'absolute',
    alignSelf: 'center',
  },
});
