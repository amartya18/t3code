import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { isHomeThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreads, environmentThreadShells } from "../../state/threads";
import { readHomeView } from "./homeView";
import { VoiceWaveIcon } from "./VoiceWaveIcon";
import { startVoiceSession, voiceSessionAtom } from "./voiceSession";
import { useVoiceModeSettings } from "./voiceSettings";

/** Fork hook in ThreadComposer: the Voice button in Home's thread. */
export function HomeVoiceSlot(props: {
  readonly thread: EnvironmentThreadShell;
  readonly large: boolean;
}) {
  if (!isHomeThreadId(props.thread.id)) return null;
  return <HomeVoiceButton home={props.thread} large={props.large} />;
}

function HomeVoiceButton(props: {
  readonly home: EnvironmentThreadShell;
  readonly large: boolean;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const settings = useVoiceModeSettings();
  const [starting, setStarting] = useState(false);
  const { scale } = useAndroidControlSizing();
  const circleSize = Math.round((props.large ? 44 : 30) * scale);
  const unavailable = settings === null;

  const start = async () => {
    if (settings === null) {
      Dialog.alert(
        gt("No Voice project"),
        gt(
          "Voice mode needs a project titled Voice on Home's machine. Add one, or pick another project in Voice settings.",
        ),
      );
      return;
    }
    if (starting) return;
    if (appAtomRegistry.get(voiceSessionAtom) !== null) {
      navigation.navigate("VoiceCall");
      return;
    }
    setStarting(true);
    const home = { environmentId: props.home.environmentId, threadId: props.home.id };
    const homeState = AsyncResult.getOrElse(
      appAtomRegistry.get(environmentThreads.stateAtom(home.environmentId, home.threadId)),
      () => EMPTY_ENVIRONMENT_THREAD_STATE,
    );
    const started = await startVoiceSession({
      settings,
      home,
      view: readHomeView({
        homeShell: props.home,
        homeMessages: Option.getOrNull(Option.map(homeState.data, (data) => data.messages)),
        shells: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
      }),
      nowMs: Date.now(),
    }).then(
      (thread) => ({ thread }),
      (error: unknown) => ({ error }),
    );
    setStarting(false);
    if ("thread" in started) {
      navigation.navigate("VoiceCall");
    } else {
      Dialog.alert(
        gt("Could not start voice mode"),
        started.error instanceof Error ? started.error.message : undefined,
      );
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        unavailable ? gt("Voice mode, no Voice project found") : gt("Start voice mode")
      }
      accessibilityState={{ disabled: unavailable || starting }}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      style={props.large ? { width: 62 } : undefined}
      disabled={starting}
      onPress={() => void start()}
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
