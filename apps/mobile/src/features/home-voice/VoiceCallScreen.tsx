import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { useGT } from "gt-react-native";
import { memo, useEffect, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, {
  FadeIn,
  LayoutAnimationConfig,
  LinearTransition,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { callGlow, callWaveHeights } from "./callWave";
import { useVoiceConnection, useVoiceThread } from "./useVoiceCall";
import {
  retryVoiceEngine,
  voiceSpeechAtom,
  voiceTranscriptSpeechAtom,
  type VoiceSpeechView,
} from "./useVoiceSpeech";
import {
  CircleButton,
  HangUpButton,
  MicWaveform,
  MuteButton,
  SessionSettingsButton,
  useSendSweep,
  useThemeColor,
  useVoiceWave,
  VoiceClockTitle,
  type VoiceWave,
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
      <View className="flex-1" style={{ paddingTop: insets.top + 8 }}>
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
        <VoiceTranscript session={props.session} />
        {VOICE_ENGINE_SUPPORT === "available" ? null : (
          <TypedMessageField session={props.session} />
        )}
        <CallControls muted={props.session.muted} paddingBottom={Math.max(insets.bottom, 16) + 8} />
      </View>
    </KeyboardAvoidingView>
  );
}

const CALL_WAVE = callWaveHeights(29, 30);

/** Mute, the wave, and hang up, over a glow that rises while Amar talks. */
function CallControls(props: { readonly muted: boolean; readonly paddingBottom: number }) {
  const wave = useVoiceWave();
  useSendSweep(wave);
  return (
    <View className="pt-5" style={{ paddingBottom: props.paddingBottom }}>
      <CallGlow wave={wave} />
      <View className="flex-row items-center justify-between px-7">
        <MuteButton muted={props.muted} size={58} />
        <MicWaveform heights={CALL_WAVE} wave={wave} dot={3} />
        <HangUpButton size={58} />
      </View>
    </View>
  );
}

/** A gradient drawn once; only its opacity and scale move, on the UI thread. */
function CallGlow(props: { readonly wave: VoiceWave }) {
  const blue = useThemeColor("text-primary");
  const { energy, sweep } = props.wave;
  const style = useAnimatedStyle(() => {
    const glow = callGlow({ energy: energy.value, sweep: sweep.value });
    return { opacity: glow.opacity, transform: [{ scaleY: glow.scale }] };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { transformOrigin: "bottom" }, style]}
    >
      <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id="voice-call-glow" cx="50%" cy="100%" rx="60%" ry="100%">
            <Stop offset="0" stopColor={blue} stopOpacity={0.55} />
            <Stop offset="0.45" stopColor={blue} stopOpacity={0.18} />
            <Stop offset="0.75" stopColor={blue} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100" height="100" fill="url(#voice-call-glow)" />
      </Svg>
    </Animated.View>
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

const ROW_ENTERING = FadeIn.duration(180);
const ROW_LAYOUT = LinearTransition.duration(180);
/** How close to the end still counts as reading the newest line, so new lines scroll into view. */
const FOLLOW_SLACK = 24;

function useFollowNewest() {
  const ref = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const following = useRef(true);
  const laidOut = useRef(false);
  const release = () => {
    following.current = false;
  };
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    following.current =
      contentSize.height - contentOffset.y - layoutMeasurement.height <= FOLLOW_SLACK;
  };
  return {
    ref,
    onScrollBeginDrag: release,
    onMomentumScrollBegin: release,
    onScrollEndDrag: settle,
    onMomentumScrollEnd: settle,
    onContentSizeChange: () => {
      if (!following.current) return;
      ref.current?.scrollToEnd({ animated: laidOut.current });
      laidOut.current = true;
    },
  };
}

/** Every line of the call, pinned to the newest; scrolling up to read stops the pinning. */
function VoiceTranscript(props: { readonly session: VoiceSession }) {
  const gt = useGT();
  const { thread } = props.session;
  const state = useVoiceThread(props.session);
  const connection = useVoiceConnection(thread);
  const speech = useAtomValue(voiceTranscriptSpeechAtom);
  const follow = useFollowNewest();
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
    speech,
  );

  return (
    <>
      <ScrollView
        {...follow}
        className="flex-1"
        contentContainerClassName="grow justify-end gap-3 px-6 pb-3 pt-4"
        accessibilityLiveRegion="polite"
      >
        <LayoutAnimationConfig skipEntering>
          {lines.map((line, index) => (
            <TranscriptRow
              key={line.id}
              kind={line.kind}
              text={line.kind === "homeReply" ? "" : line.text}
              newest={index === lines.length - 1}
            />
          ))}
        </LayoutAnimationConfig>
      </ScrollView>
      <View className="gap-1 px-6">
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
    </>
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
          {note(gt("About 700 MB, once. Use Wi-Fi if you can."))}
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
      return (
        <View className="gap-0.5">
          {note(gt("Loading voice models…"))}
          <SlowLoadNote />
        </View>
      );
    case "checking":
    case "listening":
      return null;
  }
}

const SLOW_LOAD_NOTE_MS = 3_000;

function SlowLoadNote() {
  const gt = useGT();
  const [slow, setSlow] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer: the note shows only once loading runs long
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_LOAD_NOTE_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!slow) return null;
  return (
    <Text className="text-xs text-foreground-muted">
      {gt("The first call after an update can take up to a minute.")}
    </Text>
  );
}

/** One line of the call; memoized so a streamed reply redraws only its own row. */
const TranscriptRow = memo(function TranscriptRow(props: {
  readonly kind: TranscriptLine["kind"];
  readonly text: string;
  readonly newest: boolean;
}) {
  return (
    <Animated.View entering={ROW_ENTERING} layout={ROW_LAYOUT}>
      <TranscriptLineText {...props} />
    </Animated.View>
  );
});

function TranscriptLineText(props: {
  readonly kind: TranscriptLine["kind"];
  readonly text: string;
  readonly newest: boolean;
}) {
  const gt = useGT();
  if (props.kind === "homeReply" || props.kind === "homeNote") {
    return (
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name="house"
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text numberOfLines={2} className="shrink text-xs text-foreground-muted">
          {props.kind === "homeReply" ? gt("Home replied") : props.text}
        </Text>
      </View>
    );
  }
  if (props.kind === "agent") {
    return (
      <Text
        className={cn("text-base", props.newest ? "text-foreground" : "text-foreground-muted")}
        style={{ maxWidth: "88%" }}
      >
        {props.text}
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
      {props.text}
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
