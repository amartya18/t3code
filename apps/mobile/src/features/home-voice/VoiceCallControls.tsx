import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useVoiceClock } from "./useVoiceCall";
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

/** A fixed dotted waveform: it marks the call, it does not meter sound. */
export function StaticWaveform() {
  const heights = [3, 5, 8, 5, 10, 6, 3, 7, 4, 3];
  return (
    <View className="flex-row items-center gap-[3px]" accessibilityElementsHidden>
      {heights.map((height, index) => (
        <View
          // oxlint-disable-next-line react/no-array-index-key -- a fixed decoration
          key={index}
          style={{ height, width: 3 }}
          className="rounded-full bg-foreground-muted"
        />
      ))}
    </View>
  );
}
