import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { voiceEngine } from "../../../modules/t3-voice-mode";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentThread } from "../../state/threads";
import { DEFAULT_END_OF_TURN_CONFIG, sendCountdown } from "./endOfTurn";
import { DEFAULT_BARGE_IN_CONFIG } from "./speechQueue";
import { ECHO_CANCELLATION, voiceEngineConfig } from "./voiceEngine";
import { sendVoiceMessage, type VoiceSession } from "./voiceSession";
import { useVoiceModeSettings } from "./voiceSettings";
import {
  liveWords,
  type OwnLine,
  type ReplyShown,
  type VoiceEngineStatus,
  type VoiceSpeechConfig,
  type VoiceSpeechEvent,
  type VoiceSpeechState,
} from "./voiceSpeech";
import {
  createVoiceSpeechDriver,
  type VoiceSpeechDriver,
  type VoiceSpeechInputs,
} from "./voiceSpeechDriver";
import type { TranscriptSpeech } from "./voiceTranscript";

/** What the call screen draws of the speech session. */
export interface VoiceSpeechView {
  readonly engine: VoiceEngineStatus;
  readonly own: OwnLine | null;
  readonly shown: ReadonlyMap<string, ReplyShown>;
  readonly current: string | null;
  /** The pause before the current line sends; `held` while a touch or "hang on" holds it. */
  readonly pause: {
    readonly sinceMs: number;
    readonly pauseMs: number;
    readonly held: boolean;
  } | null;
}

export const voiceSpeechAtom = Atom.make<VoiceSpeechView | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("home-voice:speech"),
);

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

/** The empty middle of the call: sends the pause now, or stops the voice. */
export function tapVoiceStage() {
  live?.dispatch({ type: "tap", atMs: Date.now() });
}

export function holdVoiceStage(holding: boolean) {
  live?.dispatch({ type: holding ? "holdStart" : "holdEnd", atMs: Date.now() });
}

export function retryVoiceEngine() {
  live?.dispatch({ type: "retry" });
}

/** Runs on-device speech for the session's whole life, whether its call screen is open or not. */
export function useVoiceSpeech(session: VoiceSession) {
  const { thread, muted } = session;
  const settings = useVoiceModeSettings();
  const threadState = useEnvironmentThread(thread.environmentId, thread.threadId);
  const messages = Option.getOrNull(Option.map(threadState.data, (data) => data.messages));
  const inputs: VoiceSpeechInputs = {
    engineConfig: voiceEngineConfig(settings?.voiceId ?? "af_heart"),
    config: {
      endOfTurn: {
        ...DEFAULT_END_OF_TURN_CONFIG,
        pauseMs: settings?.pauseMs ?? DEFAULT_END_OF_TURN_CONFIG.pauseMs,
        earlySend: settings?.earlySend ?? DEFAULT_END_OF_TURN_CONFIG.earlySend,
      },
      bargeIn: DEFAULT_BARGE_IN_CONFIG,
      voiceBargeIn: ECHO_CANCELLATION,
    },
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
      now: Date.now,
      newMessageId: uuidv4,
      log: (line) => console.log(line),
      onChange: (state, config) => {
        remembered = { key, state };
        publish(state, config);
      },
    });
    live = driver;
    return () => {
      driver.dispose();
      if (live === driver) live = null;
      appAtomRegistry.set(voiceSpeechAtom, null);
    };
  }, [key]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mute silences the native mic
  useEffect(() => {
    live?.dispatch({ type: "muted", muted, atMs: Date.now() });
  }, [muted]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- streamed replies go out through the native voice
  useEffect(() => {
    live?.dispatch(threadEvent(messages ?? [], Date.now()));
  }, [messages]);
}

function threadEvent(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  atMs: number,
): VoiceSpeechEvent {
  return {
    type: "thread",
    replies: messages
      .filter((message) => message.role === "assistant" && message.notification === undefined)
      .map((message) => ({ id: message.id, text: message.text, streaming: message.streaming })),
    userMessageIds: new Set(
      messages.filter((message) => message.role === "user").map((message) => message.id),
    ),
    atMs,
  };
}

function publish(state: VoiceSpeechState, config: VoiceSpeechConfig) {
  const turn = state.turn;
  const next: VoiceSpeechView = {
    engine: state.engine,
    own: state.own,
    shown: state.shown,
    current: liveWords(state),
    pause:
      turn.kind === "paused"
        ? {
            sinceMs: turn.since,
            pauseMs: config.endOfTurn.pauseMs,
            held: sendCountdown(turn, turn.since, config.endOfTurn)?.held ?? false,
          }
        : null,
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
    left.current === right.current &&
    left.pause?.sinceMs === right.pause?.sinceMs &&
    left.pause?.pauseMs === right.pause?.pauseMs &&
    left.pause?.held === right.pause?.held
  );
}
