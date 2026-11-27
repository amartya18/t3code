import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Linking, Pressable, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentThread } from "../../state/threads";
import { useVoiceConnection } from "./useVoiceCall";
import {
  holdVoiceStage,
  retryVoiceEngine,
  tapVoiceStage,
  voiceOwnLineAtom,
  voiceSpeechAtom,
  type VoiceSpeechView,
} from "./useVoiceSpeech";
import {
  CircleButton,
  HangUpButton,
  MuteButton,
  SessionSettingsButton,
  VoiceClockTitle,
} from "./VoiceCallControls";
import { VOICE_ENGINE_SUPPORT } from "./voiceEngine";
import {
  sendVoiceMessage,
  VOICE_THREAD_TAG,
  voiceSessionAtom,
  type VoiceSession,
} from "./voiceSession";
import { useVoiceModeSettings } from "./voiceSettings";
import { voiceTranscript, type TranscriptLine } from "./voiceTranscript";

/** The full-screen call: the session's time, its last few lines, mute and hang up. */
export function VoiceCallScreen() {
  const session = useAtomValue(voiceSessionAtom);
  const navigation = useNavigation();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the router owns this screen; hanging up, or a restored route with no call, closes it
  useEffect(() => {
    if (session === null && navigation.isFocused() && navigation.canGoBack()) navigation.goBack();
  }, [session, navigation]);
  if (session === null) return null;
  return <VoiceCall session={session} />;
}

function VoiceCall(props: { readonly session: VoiceSession }) {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { thread } = props.session;

  return (
    <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1 bg-screen">
      <View
        className="flex-1"
        style={{ paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 16) + 8 }}
      >
        <View className="flex-row items-center justify-between px-4">
          <CircleButton
            icon="chevron.down"
            label={gt("Minimize")}
            size={44}
            raised
            onPress={() => navigation.goBack()}
          />
          <VoiceClockTitle
            startedAtMs={props.session.startedAtMs}
            className="font-t3-bold text-lg"
          />
          <SessionSettingsButton size={44} raised />
        </View>
        <HiddenThreadNotice environmentId={thread.environmentId} />
        {VOICE_ENGINE_SUPPORT === "available" ? (
          <VoiceStage>
            <VoiceTranscript session={props.session} />
          </VoiceStage>
        ) : (
          <>
            <View className="flex-1" />
            <VoiceTranscript session={props.session} />
            <TypedMessageField session={props.session} />
          </>
        )}
        <View className="flex-row items-center justify-between px-7 pt-5">
          <MuteButton muted={props.session.muted} size={58} />
          <HangUpButton size={58} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function HiddenThreadNotice(props: {
  readonly environmentId: VoiceSession["thread"]["environmentId"];
}) {
  const gt = useGT();
  const hiddenTags = useAtomValue(serverEnvironment.hiddenThreadTagsAtom(props.environmentId));
  if (hiddenTags?.includes(VOICE_THREAD_TAG) === true) return null;
  const notice = gt(
    "This voice thread shows in your thread lists. Turn on hiding for the voice tag in this server's settings to keep it out.",
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={notice}
      className="mt-2 flex-row items-center justify-center gap-1.5 self-center px-3 py-1 active:opacity-70"
      onPress={() => Dialog.alert(gt("Voice thread not hidden"), notice)}
    >
      <SymbolView
        name="exclamationmark.triangle"
        size={13}
        tintColorClassName="accent-warning-foreground"
        type="monochrome"
      />
      <Text className="text-xs text-warning-foreground">{gt("Voice thread not hidden")}</Text>
    </Pressable>
  );
}

/** Everything above the controls: a tap sends the pause now or stops the voice, a press and hold waits. */
function VoiceStage(props: { readonly children: ReactNode }) {
  const gt = useGT();
  const holding = useRef(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Send now or interrupt")}
      accessibilityHint={gt("Press and hold to keep waiting")}
      className="flex-1 justify-end"
      delayLongPress={350}
      onPress={tapVoiceStage}
      onLongPress={() => {
        holding.current = true;
        void Haptics.selectionAsync();
        holdVoiceStage(true);
      }}
      onPressOut={() => {
        if (!holding.current) return;
        holding.current = false;
        holdVoiceStage(false);
      }}
    >
      {props.children}
    </Pressable>
  );
}

function VoiceTranscript(props: { readonly session: VoiceSession }) {
  const gt = useGT();
  const { thread } = props.session;
  const state = useEnvironmentThread(thread.environmentId, thread.threadId);
  const connection = useVoiceConnection(thread);
  const own = useAtomValue(voiceOwnLineAtom);
  const sent = Option.match(state.data, {
    onNone: () => [],
    onSome: (data) =>
      data.messages
        .filter((message) => message.notification === undefined)
        .map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
        })),
  });
  const lines = voiceTranscript(
    sent,
    connection.queued.map((message) => ({
      id: message.messageId,
      role: "user" as const,
      text: message.text,
    })),
    own,
  );

  return (
    <View className="gap-3 px-6" accessibilityLiveRegion="polite">
      {lines.map((line, index) =>
        line.kind === "user" ? (
          <TranscriptRow key={line.id} line={line} newest={index === lines.length - 1} />
        ) : (
          <Animated.View key={line.id} entering={FadeIn.duration(180)}>
            <TranscriptRow line={line} newest={index === lines.length - 1} />
          </Animated.View>
        ),
      )}
      <LiveWords />
      <SpeechNotes />
      {connection.offline ? (
        <Text className="text-xs text-foreground-muted">
          {gt("Reconnecting")}
          {connection.queued.length > 0
            ? ` · ${gt("{count} waiting to send", { count: connection.queued.length })}`
            : ""}
          {" · "}
          <Text
            accessibilityRole="button"
            className="text-xs text-primary-text"
            onPress={connection.retry}
          >
            {gt("Retry")}
          </Text>
        </Text>
      ) : null}
    </View>
  );
}

/** Amar's words while he talks; the only part that changes on every partial. */
function LiveWords() {
  const speech = useAtomValue(voiceSpeechAtom);
  if (speech?.current == null) return null;
  return (
    <View className="items-end gap-1.5 self-end" style={{ maxWidth: "80%" }}>
      <Text className="text-base text-right text-foreground-muted">{speech.current}</Text>
      {speech.pause != null ? <SendCountdown {...speech.pause} /> : null}
    </View>
  );
}

function SpeechNotes() {
  const gt = useGT();
  const speech = useAtomValue(voiceSpeechAtom);
  return (
    <>
      {speech === null ? null : <EngineNote engine={speech.engine} />}
      {VOICE_ENGINE_SUPPORT === "unsafeIos" ? (
        <Text className="text-xs text-foreground-muted">
          {gt("Voice is off on iOS 26.4 and later, where it crashes for now")}
        </Text>
      ) : null}
    </>
  );
}

/** A hairline under the line about to be sent: drains over the pause, full and grey while held. */
function SendCountdown(props: NonNullable<VoiceSpeechView["pause"]>) {
  const { sinceMs, pauseMs, held } = props;
  const remaining = useSharedValue(1);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the drain runs on the UI thread and restarts with each pause
  useEffect(() => {
    cancelAnimation(remaining);
    if (held) {
      remaining.value = 1;
      return;
    }
    const left = Math.min(1, Math.max(0, 1 - (Date.now() - sinceMs) / pauseMs));
    remaining.value = left;
    remaining.value = withTiming(0, { duration: left * pauseMs, easing: Easing.linear });
  }, [sinceMs, pauseMs, held, remaining]);
  const fill = useAnimatedStyle(() => ({ width: `${remaining.value * 100}%` }));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="h-0.5 w-[120px] max-w-full overflow-hidden rounded-full bg-border"
    >
      <Animated.View
        style={fill}
        className={cn(
          "absolute bottom-0 right-0 top-0",
          held ? "bg-foreground-muted" : "bg-primary",
        )}
      />
    </View>
  );
}

/** Where the on-device voice stands, when it isn't simply listening. */
function EngineNote(props: { readonly engine: VoiceSpeechView["engine"] }) {
  const gt = useGT();
  const { engine } = props;
  const note = (
    text: string,
    action?: { readonly label: string; readonly onPress: () => void },
  ) => (
    <Text className="text-xs text-foreground-muted">
      {text}
      {action === undefined ? null : (
        <>
          {" · "}
          <Text
            accessibilityRole="button"
            className="text-xs text-primary-text"
            onPress={action.onPress}
          >
            {action.label}
          </Text>
        </>
      )}
    </Text>
  );
  switch (engine.kind) {
    case "downloading":
      return (
        <View className="gap-0.5">
          {note(
            gt("Downloading voice · {percent}%", { percent: Math.floor(engine.fraction * 100) }),
          )}
          {note(gt("About 320 MB, once. Use Wi-Fi if you can."))}
        </View>
      );
    case "downloadFailed":
      return note(gt("Voice download failed"), { label: gt("Retry"), onPress: retryVoiceEngine });
    case "micDenied":
      return note(gt("Microphone access is off"), {
        label: gt("Open Settings"),
        onPress: () => void Linking.openSettings(),
      });
    case "interrupted":
      return note(gt("Paused while another app uses audio"));
    case "failed":
      return note(gt("Voice stopped working"), { label: gt("Retry"), onPress: retryVoiceEngine });
    case "starting":
      return note(gt("Starting voice…"));
    case "checking":
    case "listening":
      return null;
  }
}

function TranscriptRow(props: { readonly line: TranscriptLine; readonly newest: boolean }) {
  const gt = useGT();
  const { line } = props;
  if (line.kind === "homeReply" || line.kind === "homeNote") {
    return (
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name="house"
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text numberOfLines={2} className="shrink text-xs text-foreground-muted">
          {line.kind === "homeReply" ? gt("Home replied") : line.text}
        </Text>
      </View>
    );
  }
  if (line.kind === "agent") {
    return (
      <Text
        className={cn("text-base", props.newest ? "text-foreground" : "text-foreground-muted")}
        style={{ maxWidth: "88%" }}
      >
        {line.text}
      </Text>
    );
  }
  return (
    <Text
      className={cn(
        "text-base self-end text-right text-foreground-muted",
        !props.newest && "opacity-70",
      )}
      style={{ maxWidth: "80%" }}
    >
      {line.text}
    </Text>
  );
}

/** Until this build has speech, Amar types what he would say. */
function TypedMessageField(props: { readonly session: VoiceSession }) {
  const gt = useGT();
  const settings = useVoiceModeSettings();
  const [text, setText] = useState("");
  const send = () => {
    const message = text.trim();
    if (message === "" || settings === null) return;
    setText("");
    void sendVoiceMessage(props.session.thread, settings, message).catch(() => {
      setText(message);
    });
  };
  return (
    <View className="flex-row items-center gap-2 px-4 pt-4">
      <TextInput
        accessibilityLabel={gt("Message the voice agent")}
        className="min-h-11 flex-1 rounded-full py-2.5"
        placeholder={gt("Type until speech arrives")}
        value={text}
        onChangeText={setText}
        returnKeyType="send"
        submitBehavior="submit"
        onSubmitEditing={send}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Send")}
        accessibilityState={{ disabled: text.trim() === "" }}
        disabled={text.trim() === ""}
        onPress={send}
        className={cn(
          "size-11 items-center justify-center rounded-full active:opacity-70",
          text.trim() === "" ? "bg-subtle-strong" : "bg-primary",
        )}
      >
        <SymbolView
          name="arrow.up"
          size={18}
          tintColorClassName={
            text.trim() === "" ? "accent-icon-subtle" : "accent-primary-foreground"
          }
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
