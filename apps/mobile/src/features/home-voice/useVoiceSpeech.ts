import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";

import { voiceEngine } from "../../../modules/t3-voice-mode";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { HOME_UPDATE } from "./homeUpdates";
import { useVoiceThread } from "./useVoiceCall";
import { ECHO_CANCELLATION, voiceEngineConfig } from "./voiceEngine";
import { endVoiceSession, sendVoiceMessage, type VoiceSession } from "./voiceSession";
import { useVoiceModeSettings } from "./voiceSettings";
import {
  isHearing,
  type OwnLine,
  type ReplyShown,
  type VoiceEngineStatus,
  type VoiceSpeechEvent,
  type VoiceSpeechState,
} from "./voiceSpeech";
import {
  createVoiceSpeechDriver,
  type VoiceSpeechDriver,
  type VoiceSpeechInputs,
} from "./voiceSpeechDriver";
import type { TranscriptSpeech } from "./voiceTranscript";
import { voiceVocabulary } from "./voiceVocabulary";

/** What the call screen draws of the speech session. */
export interface VoiceSpeechView {
  readonly engine: VoiceEngineStatus;
  readonly own: OwnLine | null;
  readonly shown: ReadonlyMap<string, ReplyShown>;
  readonly hearing: boolean;
}

export const voiceSpeechAtom = Atom.make<VoiceSpeechView | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("home-voice:speech"),
);

/** Flips only when Amar starts or stops talking, so the minimized call redraws that rarely. */
export const voiceHearingAtom = Atom.make((get) => get(voiceSpeechAtom)?.hearing === true).pipe(
  Atom.withLabel("home-voice:hearing"),
);

/** The id of Amar's latest line sent by voice; changes once per sent line. */
export const voiceSentAtom = Atom.make(
  (get): string | null =>
    get(voiceSpeechAtom)?.own?.messageId ?? Option.getOrNull(get.self<string | null>()),
).pipe(Atom.withLabel("home-voice:sent"));

/** What the transcript draws of the session; changes once a line or a chunk, not every word. */
export const voiceTranscriptSpeechAtom = Atom.make((get): TranscriptSpeech | null => {
  const view = get(voiceSpeechAtom);
  if (view === null) return null;
  const previous = Option.getOrNull(get.self<TranscriptSpeech | null>());
  return previous?.own === view.own && previous.shown === view.shown
    ? previous
    : { own: view.own, shown: view.shown };
}).pipe(Atom.withLabel("home-voice:transcript-speech"));

let live: VoiceSpeechDriver | null = null;
/** Outlives a remount of the runner, so a restarted engine never repeats a reply. */
let remembered: { readonly key: string; readonly state: VoiceSpeechState } | null = null;

export function retryVoiceEngine() {
  live?.dispatch({ type: "retry" });
}

/** Runs on-device speech for the session's whole life, whether its call screen is open or not. */
export function useVoiceSpeech(session: VoiceSession) {
  const { thread, muted } = session;
  const settings = useVoiceModeSettings();
  const threadState = useVoiceThread(session);
  const messages = Option.getOrNull(Option.map(threadState.data, (data) => data.messages));
  const engineConfig = voiceEngineConfig(settings?.voiceId ?? "af_heart");
  const inputs: VoiceSpeechInputs = {
    engineConfig,
    config: { vad: engineConfig.vad, voiceBargeIn: ECHO_CANCELLATION },
    send: (text, messageId) =>
      settings === null
        ? Promise.reject(new Error("No voice project"))
        : sendVoiceMessage(thread, settings, text, messageId),
  };
  const latest = useRef(inputs);
  const key = `${thread.environmentId}:${thread.threadId}`;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native engine reads its tuning from the session's settings
  useEffect(() => {
    latest.current = inputs;
    live?.update(inputs);
  }, [inputs]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native engine runs for as long as the session does
  useEffect(() => {
    if (voiceEngine === null) return;
    const driver = createVoiceSpeechDriver({
      engine: voiceEngine,
      inputs: latest.current,
      previous: remembered?.key === key ? remembered.state : null,
      vocabulary: voiceVocabulary({
        environmentId: thread.environmentId,
        projects: appAtomRegistry.get(environmentProjects.projectsAtom),
        threads: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
      }),
      now: Date.now,
      newMessageId: uuidv4,
      log: (line) => console.log(line),
      onReady: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
      onHangUp: endVoiceSession,
      onChange: (state) => {
        remembered = { key, state };
        publish(state);
      },
    });
    live = driver;
    return () => {
      driver.dispose();
      if (live === driver) live = null;
      appAtomRegistry.set(voiceSpeechAtom, null);
    };
  }, [key, thread.environmentId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mute silences the native mic
  useEffect(() => {
    live?.dispatch({ type: "muted", muted, atMs: Date.now() });
  }, [muted]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- streamed replies go out through the native voice
  useEffect(() => {
    live?.dispatch(threadEvent(messages ?? [], Date.now()));
  }, [messages]);
}

export function threadEvent(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  atMs: number,
): Extract<VoiceSpeechEvent, { type: "thread" }> {
  return {
    type: "thread",
    replies: messages
      .filter((message) => message.role === "assistant" && message.notification === undefined)
      .map((message) => ({ id: message.id, text: message.text, streaming: message.streaming })),
    userMessageIds: new Set(
      messages.filter((message) => message.role === "user").map((message) => message.id),
    ),
    lastLine:
      messages.findLast(
        (message) =>
          message.role === "user" &&
          message.notification === undefined &&
          !message.text.startsWith(HOME_UPDATE),
      )?.text ?? null,
    atMs,
  };
}

function publish(state: VoiceSpeechState) {
  const next: VoiceSpeechView = {
    engine: state.engine,
    own: state.own,
    shown: state.shown,
    hearing: isHearing(state),
  };
  const shown = appAtomRegistry.get(voiceSpeechAtom);
  if (shown !== null && sameView(shown, next)) return;
  appAtomRegistry.set(voiceSpeechAtom, next);
}

function sameView(left: VoiceSpeechView, right: VoiceSpeechView): boolean {
  return (
    left.engine === right.engine &&
    left.own === right.own &&
    left.shown === right.shown &&
    left.hearing === right.hearing
  );
}
