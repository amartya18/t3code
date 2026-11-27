import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useVoiceClock } from "./useVoiceCall";
import { voiceHearingAtom } from "./useVoiceSpeech";
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

/**
 * A dotted wave that moves while the mic hears Amar and settles when he stops. The engine reports
 * only when his voice starts and stops, so it follows his voice, not how loud it is.
 */
export function MicWaveform(props: { readonly heights: ReadonlyArray<number> }) {
  const hearing = useAtomValue(voiceHearingAtom);
  const reducedMotion = useReducedMotion();
  const phase = useSharedValue(0);
  const energy = useSharedValue(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the wave runs on the UI thread, only while he talks
  useEffect(() => {
    if (!hearing || reducedMotion) {
      cancelAnimation(phase);
      energy.value = withTiming(0, { duration: 250 });
      return;
    }
    energy.value = withTiming(1, { duration: 150 });
    phase.value = withRepeat(
      withTiming(phase.value + 1, { duration: WAVE_PERIOD_MS, easing: Easing.linear }),
      -1,
    );
  }, [hearing, reducedMotion, phase, energy]);
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
          offset={index * 0.17}
          phase={phase}
          energy={energy}
          lit={hearing}
        />
      ))}
    </View>
  );
}

function WaveBar(props: {
  readonly height: number;
  readonly offset: number;
  readonly phase: SharedValue<number>;
  readonly energy: SharedValue<number>;
  readonly lit: boolean;
}) {
  const { offset, phase, energy } = props;
  const swing = useAnimatedStyle(() => ({
    transform: [
      {
        scaleY:
          1 + energy.value * 0.8 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (phase.value + offset))),
      },
    ],
  }));
  return (
    <Animated.View
      style={[{ height: props.height, width: 3 }, swing]}
      className={cn("rounded-full", props.lit ? "bg-primary" : "bg-foreground-muted")}
    />
  );
}
