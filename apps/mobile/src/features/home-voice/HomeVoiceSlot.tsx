import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EMPTY_ENVIRONMENT_THREAD_STATE } from "@t3tools/client-runtime/state/threads";
import { isHomeThreadId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { cn } from "../../lib/cn";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell, useThreadShells } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import {
  environmentThreads,
  environmentThreadShells,
  useEnvironmentThread,
} from "../../state/threads";
import { readHomeView } from "./homeView";
import { VoiceWaveIcon } from "./VoiceWaveIcon";
import {
  endVoiceSession,
  ensureVoiceTag,
  pushHomeUpdates,
  startVoiceSession,
  VOICE_THREAD_TAG,
  voiceSessionAtom,
  type VoiceSession,
} from "./voiceSession";
import { useVoiceModeSettings } from "./voiceSettings";

/** Fork hook in ThreadComposer: the Voice button in Home's thread, the session runner in a voice thread. */
export function HomeVoiceSlot(props: {
  readonly thread: EnvironmentThreadShell;
  readonly large: boolean;
}) {
  if (isHomeThreadId(props.thread.id)) {
    return <HomeVoiceButton home={props.thread} large={props.large} />;
  }
  return <VoiceSessionSlot thread={props.thread} large={props.large} />;
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
      navigation.dispatch(StackActions.push("Thread", started.thread));
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

function VoiceSessionSlot(props: {
  readonly thread: EnvironmentThreadShell;
  readonly large: boolean;
}) {
  const session = useAtomValue(voiceSessionAtom);
  if (
    session === null ||
    session.thread.environmentId !== props.thread.environmentId ||
    session.thread.threadId !== props.thread.id
  ) {
    return null;
  }
  return <LiveVoiceSession session={session} large={props.large} />;
}

/** Runs while the live session's thread is on screen: tags it, and relays what changes at Home. */
function LiveVoiceSession(props: { readonly session: VoiceSession; readonly large: boolean }) {
  const gt = useGT();
  const navigation = useNavigation();
  const { thread, home } = props.session;
  const voiceShell = useThreadShell(thread);
  const homeShell = useThreadShell(home);
  const homeState = useEnvironmentThread(home.environmentId, home.threadId);
  const shells = useThreadShells();
  const hiddenTags = useAtomValue(serverEnvironment.hiddenThreadTagsAtom(thread.environmentId));
  const view = readHomeView({
    homeShell,
    homeMessages: Option.getOrNull(Option.map(homeState.data, (data) => data.messages)),
    shells,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the voice thread's tag lives on the server
  useEffect(() => {
    if (voiceShell !== null) ensureVoiceTag(voiceShell);
  }, [voiceShell]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Home's changes go out through the outbox
  useEffect(() => {
    pushHomeUpdates(thread, view);
  }, [thread, view]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- router listener: the composer can remount while the screen stays, so only leaving the screen ends the session
  useEffect(
    () => navigation.addListener("beforeRemove", () => endVoiceSession(thread)),
    [navigation, thread],
  );

  if (hiddenTags?.includes(VOICE_THREAD_TAG) === true) return null;
  const notice = gt(
    "This voice thread shows in your thread lists. Turn on hiding for the voice tag in this server's settings to keep it out.",
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={notice}
      className="size-[44px] shrink-0 items-center justify-center active:opacity-70"
      style={props.large ? { width: 62 } : undefined}
      onPress={() => Dialog.alert(gt("Voice thread not hidden"), notice)}
    >
      <SymbolView
        name="exclamationmark.triangle"
        size={props.large ? 20 : 16}
        tintColorClassName="accent-warning-foreground"
        type="monochrome"
      />
    </Pressable>
  );
}
