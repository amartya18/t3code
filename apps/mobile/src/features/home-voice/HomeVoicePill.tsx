import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { useVoiceConnection } from "./useVoiceCall";
import {
  HangUpButton,
  MuteButton,
  MicWaveform,
  SessionSettingsButton,
  VoiceClockTitle,
} from "./VoiceCallControls";
import { useVoiceModelOptions } from "./voiceModels";
import { voiceSessionAtom, type VoiceSession } from "./voiceSession";
import { useVoiceModeSettings } from "./voiceSettings";

const PILL_WAVE = [3, 5, 8, 5, 10, 6, 3, 7, 4, 3];

/** Fork hook on Home's thread: the minimized call, below the header. Tap returns to the call. */
export function HomeVoicePill(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly top: number;
}) {
  const session = useAtomValue(voiceSessionAtom);
  if (
    session === null ||
    session.home.environmentId !== props.environmentId ||
    session.home.threadId !== props.threadId
  ) {
    return null;
  }
  return <MinimizedCall session={session} top={props.top} />;
}

function MinimizedCall(props: { readonly session: VoiceSession; readonly top: number }) {
  const gt = useGT();
  const navigation = useNavigation();
  const connection = useVoiceConnection(props.session.thread);
  const settings = useVoiceModeSettings();
  const { selected } = useVoiceModelOptions(settings, settings?.environmentId ?? null);
  const status = connection.offline ? gt("Reconnecting") : props.session.muted ? gt("Muted") : null;
  const title = gt("Voice session");

  return (
    <View
      className="absolute left-3 right-3 z-30 flex-row items-center gap-2 rounded-full border border-border-subtle bg-card py-1.5 pl-1.5 pr-1.5 shadow-md shadow-black/15"
      style={{ top: props.top }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status === null ? title : `${title}, ${status}`}
        accessibilityHint={gt("Opens the voice session")}
        onPress={() => navigation.navigate("VoiceCall")}
        className="min-w-0 flex-1 flex-row items-center gap-2.5 active:opacity-70"
      >
        <View className="size-11 items-center justify-center rounded-full bg-subtle-strong">
          <ProviderIcon
            provider={selected?.providerDriver}
            iconUrl={selected?.providerIconUrl}
            size={20}
          />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <VoiceClockTitle
            startedAtMs={props.session.startedAtMs}
            className="font-t3-bold text-base"
          />
          {status === null ? (
            <MicWaveform heights={PILL_WAVE} />
          ) : (
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              {status}
            </Text>
          )}
        </View>
      </Pressable>
      <SessionSettingsButton size={40} />
      <MuteButton muted={props.session.muted} size={40} />
      <HangUpButton size={40} />
    </View>
  );
}
