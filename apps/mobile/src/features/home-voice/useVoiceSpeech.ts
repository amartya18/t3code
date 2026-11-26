import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { voiceEngine } from "../../../modules/t3-voice-mode";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentThread } from "../../state/threads";
import { DEFAULT_END_OF_TURN_CONFIG, sendCountdown } from "./endOfTurn";
import { DEFAULT_BARGE_IN_CONFIG } from "./speechQueue";
import { voiceEngineConfig } from "./voiceEngine";
import { sendVoiceMessage, type VoiceSession } from "./voiceSession";
import { useVoiceModeSettings } from "./voiceSettings";
import {
  liveWords,
  type AgentReply,
  type VoiceEngineStatus,
  type VoiceSpeechConfig,
  type VoiceSpeechState,
} from "./voiceSpeech";
import {
  createVoiceSpeechDriver,
  type VoiceSpeechDriver,
  type VoiceSpeechInputs,
} from "./voiceSpeechDriver";

/** What the call screen draws of the speech session. */
export interface VoiceSpeechView {
  readonly engine: VoiceEngineStatus;
  readonly sending: string | null;
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
  const replies = agentReplies(
    Option.getOrNull(Option.map(threadState.data, (data) => data.messages)),
  );
  const inputs: VoiceSpeechInputs = {
    engineConfig: voiceEngineConfig(settings?.voiceId ?? "af_heart"),
    config: {
      endOfTurn: {
        ...DEFAULT_END_OF_TURN_CONFIG,
        pauseMs: settings?.pauseMs ?? DEFAULT_END_OF_TURN_CONFIG.pauseMs,
        earlySend: settings?.earlySend ?? DEFAULT_END_OF_TURN_CONFIG.earlySend,
      },
      bargeIn: DEFAULT_BARGE_IN_CONFIG,
    },
    send: (text) =>
      settings === null
        ? Promise.reject(new Error("No voice project"))
        : sendVoiceMessage(thread, settings, text),
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
    live?.dispatch({ type: "replies", replies, atMs: Date.now() });
  }, [replies]);
}

function agentReplies(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage> | null,
): ReadonlyArray<AgentReply> {
  return (messages ?? [])
    .filter((message) => message.role === "assistant" && message.notification === undefined)
    .map((message) => ({ id: message.id, text: message.text, streaming: message.streaming }));
}

function publish(state: VoiceSpeechState, config: VoiceSpeechConfig) {
  const words = liveWords(state);
  const turn = state.turn;
  const next: VoiceSpeechView = {
    engine: state.engine,
    sending: words.sending,
    current: words.current,
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
    left.sending === right.sending &&
    left.current === right.current &&
    left.pause?.sinceMs === right.pause?.sinceMs &&
    left.pause?.pauseMs === right.pause?.pauseMs &&
    left.pause?.held === right.pause?.held
  );
}
