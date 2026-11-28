import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isHomeThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useEffect, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { cn } from "../../lib/cn";
import { openHomeVoiceCall } from "./homeVoiceCall";
import { prepareVoiceOnce } from "./voicePrepare";
import { VoiceWaveIcon } from "./VoiceWaveIcon";
import { useVoiceModeSettings } from "./voiceSettings";

/** Fork hook in ThreadComposer: in Home's thread, an empty composer's send slot starts voice mode. */
export function HomeVoiceSlot(props: {
  readonly thread: EnvironmentThreadShell;
  readonly large: boolean;
  readonly hasContent: boolean;
  readonly children: ReactNode;
}) {
  if (props.hasContent || !isHomeThreadId(props.thread.id)) return props.children;
  return <HomeVoiceButton home={props.thread} large={props.large} />;
}

function HomeVoiceButton(props: {
  readonly home: EnvironmentThreadShell;
  readonly large: boolean;
}) {
  const gt = useGT();
  const settings = useVoiceModeSettings();
  const { scale } = useAndroidControlSizing();
  const circleSize = Math.round((props.large ? 44 : 30) * scale);
  const unavailable = settings === null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the native voice models before the first call
  useEffect(() => prepareVoiceOnce(settings), [settings]);

  const start = () =>
    void openHomeVoiceCall({
      home: { environmentId: props.home.environmentId, threadId: props.home.id },
      waitMs: 0,
    });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        unavailable ? gt("Voice mode, no Voice project found") : gt("Start voice mode")
      }
      accessibilityState={{ disabled: unavailable }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      style={props.large ? { width: 62 } : undefined}
      onPress={start}
    >
      <View
        style={{ width: circleSize, height: circleSize }}
        className={cn(
          "items-center justify-center rounded-full",
          unavailable ? "bg-foreground/12 opacity-40" : "bg-primary",
        )}
      >
        <VoiceWaveIcon
          size={Math.round((props.large ? 20 : 15) * scale)}
          tintColorClassName={unavailable ? "accent-foreground" : "accent-primary-foreground"}
        />
      </View>
    </Pressable>
  );
}
