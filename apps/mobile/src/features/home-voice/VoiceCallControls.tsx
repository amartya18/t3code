import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useResolveClassNames } from "uniwind";

import { voiceEngine } from "../../../modules/t3-voice-mode";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { followMicLevel, micWaveEnergy, SWEEPS, waveBar } from "./callWave";
import { useVoiceClock } from "./useVoiceCall";
import { voiceSentAtom } from "./useVoiceSpeech";
import { VoiceCallSymbol } from "./VoiceCallSymbol";
import { endVoiceSession, toggleVoiceMuted } from "./voiceSession";

export function CircleButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly size: number;
  readonly raised?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={4}
      onPress={props.onPress}
      style={{ width: props.size, height: props.size }}
      className={cn(
        "items-center justify-center rounded-full active:opacity-70",
        props.raised ? "border border-border-subtle bg-card shadow-sm" : "bg-subtle-strong",
      )}
    >
      <SymbolView
        name={props.icon}
        size={Math.round(props.size * 0.42)}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}

export function SessionSettingsButton(props: { readonly size: number; readonly raised?: boolean }) {
  const gt = useGT();
  const navigation = useNavigation();
  return (
    <CircleButton
      icon="gearshape"
      label={gt("Session settings")}
      size={props.size}
      raised={props.raised}
      onPress={() => navigation.navigate("VoiceSessionSettings")}
    />
  );
}

export function MuteButton(props: { readonly muted: boolean; readonly size: number }) {
  const gt = useGT();
  const iconSize = Math.round(props.size * 0.42);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.muted ? gt("Unmute") : gt("Mute")}
      accessibilityState={{ selected: props.muted }}
      hitSlop={4}
      onPress={() => {
        void Haptics.selectionAsync();
        toggleVoiceMuted();
      }}
      style={{ width: props.size, height: props.size }}
      className={cn(
        "items-center justify-center rounded-full active:opacity-70",
        props.muted ? "bg-warning" : "bg-subtle-strong",
      )}
    >
      {props.muted ? (
        <VoiceCallSymbol
          name="micOff"
          size={iconSize}
          tintColorClassName="accent-warning-foreground"
        />
      ) : (
        <SymbolView
          name="mic"
          size={iconSize}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

/** "Voice · m:ss"; its own component so only this text redraws each second. */
export function VoiceClockTitle(props: {
  readonly startedAtMs: number;
  readonly className: string;
}) {
  const gt = useGT();
  const clock = useVoiceClock(props.startedAtMs);
  return (
    <AppText
      accessibilityRole="header"
      numberOfLines={1}
      className={cn("tabular-nums text-foreground", props.className)}
    >
      {gt("Voice · {clock}", { clock })}
    </AppText>
  );
}

/** Ends the session; the only way a session ends. */
export function HangUpButton(props: { readonly size: number }) {
  const gt = useGT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("End voice session")}
      hitSlop={4}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        endVoiceSession();
      }}
      style={{ width: props.size, height: props.size }}
      className="items-center justify-center rounded-full bg-danger-foreground active:opacity-70"
    >
      <VoiceCallSymbol name="hangUp" size={Math.round(props.size * 0.4)} tintColor="#ffffff" />
    </Pressable>
  );
}

const WAVE_PERIOD_MS = 900;
const SWEEP_PASS_MS = 900;

/** The wave's shared values, so the call's glow can follow the same voice. */
export interface VoiceWave {
  readonly energy: SharedValue<number>;
  readonly phase: SharedValue<number>;
  readonly sweep: SharedValue<number>;
}

/**
 * Moves the wave while the mic picks up sound and settles it when the sound stops. It follows the
 * engine's raw mic level, not voice detection, so it reacts within one tap buffer.
 */
export function useVoiceWave(): VoiceWave {
  const reducedMotion = useReducedMotion();
  const level = useSharedValue(0);
  const energy = useSharedValue(0);
  const phase = useSharedValue(0);
  const sweep = useSharedValue(SWEEPS);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native mic's level feeds the wave
  useEffect(() => (voiceEngine === null ? undefined : followMicLevel(voiceEngine, level)), [level]);
  useAnimatedReaction(
    () => micWaveEnergy(level.get()),
    (target, previous) => {
      if (target === previous) return;
      if (target > 0 && !previous) {
        cancelAnimation(sweep);
        sweep.set(SWEEPS);
        if (!reducedMotion) {
          phase.set(
            withRepeat(
              withTiming(phase.get() + 1, { duration: WAVE_PERIOD_MS, easing: Easing.linear }),
              -1,
            ),
          );
        }
      }
      if (target === 0) cancelAnimation(phase);
      energy.set(reducedMotion ? target : withTiming(target, { duration: target > 0 ? 150 : 250 }));
    },
    [reducedMotion],
  );
  return { energy, phase, sweep };
}

/** Runs the wave's highlight across it twice for each line Amar sends, then lets it rest. */
export function useSendSweep(wave: VoiceWave) {
  const sent = useAtomValue(voiceSentAtom);
  const reducedMotion = useReducedMotion();
  const swept = useRef(sent);
  const { sweep } = wave;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a sent line starts a fixed-length UI-thread animation
  useEffect(() => {
    if (sent === swept.current) return;
    swept.current = sent;
    if (sent === null || reducedMotion) return;
    sweep.set(0);
    sweep.set(withTiming(SWEEPS, { duration: SWEEPS * SWEEP_PASS_MS, easing: Easing.linear }));
  }, [sent, reducedMotion, sweep]);
}

/**
 * A dotted wave. Bars rest at their heights, or as dots `dot` tall when given, and swing up while
 * Amar talks.
 */
export function MicWaveform(props: {
  readonly heights: ReadonlyArray<number>;
  readonly wave: VoiceWave;
  readonly dot?: number;
}) {
  const grey = useThemeColor("text-foreground-muted");
  const blue = useThemeColor("text-primary");
  return (
    <View
      className="flex-row items-center gap-[3px]"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {props.heights.map((height, index) => (
        <WaveBar
          // oxlint-disable-next-line react/no-array-index-key -- a fixed decoration
          key={index}
          height={height}
          index={index}
          count={props.heights.length}
          rest={props.dot === undefined ? 1 : Math.min(1, props.dot / height)}
          peak={props.dot === undefined ? 1.8 : 1}
          wave={props.wave}
          grey={grey}
          blue={blue}
        />
      ))}
    </View>
  );
}

/** A text colour class's value, for what animates or draws its colour itself. */
export function useThemeColor(className: string): string {
  const { color } = useResolveClassNames(className);
  return typeof color === "string" ? color : "transparent";
}

function WaveBar(props: {
  readonly height: number;
  readonly index: number;
  readonly count: number;
  readonly rest: number;
  readonly peak: number;
  readonly wave: VoiceWave;
  readonly grey: string;
  readonly blue: string;
}) {
  const { index, count, rest, peak, grey, blue } = props;
  const { energy, phase, sweep } = props.wave;
  const style = useAnimatedStyle(() => {
    const bar = waveBar(
      { energy: energy.value, phase: phase.value, sweep: sweep.value },
      index,
      count,
      rest,
      peak,
    );
    return {
      transform: [{ scaleY: bar.scale }],
      backgroundColor: interpolateColor(bar.tint, [0, 1], [grey, blue]),
    };
  });
  return (
    <Animated.View style={[{ height: props.height, width: 3 }, style]} className="rounded-full" />
  );
}
