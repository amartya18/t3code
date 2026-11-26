import {
  DEFAULT_END_OF_TURN_CONFIG,
  INITIAL_END_OF_TURN_STATE,
  stepEndOfTurn,
  type EndOfTurnConfig,
  type EndOfTurnEvent,
  type EndOfTurnState,
  type FinalizeReason,
} from "./endOfTurn";
import { nextSpeechChunks, speechChunks } from "./speakable";
import {
  bargeIn,
  DEFAULT_BARGE_IN_CONFIG,
  EMPTY_SPEECH_QUEUE,
  enqueue,
  INITIAL_BARGE_IN_STATE,
  isSpeaking,
  onPlayback,
  stepBargeIn,
  type BargeInConfig,
  type BargeInEvent,
  type BargeInState,
  type SpeechQueue,
} from "./speechQueue";

export type VoiceEngineStatus =
  | { readonly kind: "checking" }
  | { readonly kind: "downloading"; readonly fraction: number }
  | { readonly kind: "downloadFailed" }
  | { readonly kind: "starting" }
  | { readonly kind: "listening" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "micDenied" }
  | { readonly kind: "failed" };

export interface AgentReply {
  readonly id: string;
  readonly text: string;
  readonly streaming: boolean;
}

interface ReplyProgress {
  readonly spoken: number;
  /** The queue revision when its first chunk was queued; a barge-in makes the rest stale. */
  readonly revision: number;
  /** Complete and fully queued, so later thread updates skip it. */
  readonly done: boolean;
}

interface TurnTiming {
  readonly turn: number;
  readonly reason: FinalizeReason;
  readonly speechEndMs: number;
  readonly finalizedMs: number | null;
  readonly sentMs: number | null;
  /** Replies already in the thread when the message was sent; the next new one answers it. */
  readonly repliesBefore: ReadonlySet<string> | null;
  readonly replyId: string | null;
  readonly firstTextMs: number | null;
}

export interface VoiceSpeechState {
  readonly engine: VoiceEngineStatus;
  readonly turn: EndOfTurnState;
  readonly bargeIn: BargeInState;
  readonly queue: SpeechQueue;
  readonly volume: number;
  /** The mic's transcript while the agent speaks: echo until Amar interrupts. */
  readonly overheard: string;
  /** Amar's finished words between finalize and the outbox taking them. */
  readonly sending: string | null;
  readonly replies: ReadonlyArray<AgentReply>;
  readonly progress: ReadonlyMap<string, ReplyProgress>;
  readonly turns: number;
  readonly timing: TurnTiming | null;
}

export interface VoiceSpeechConfig {
  readonly endOfTurn: EndOfTurnConfig;
  readonly bargeIn: BargeInConfig;
  /** Without echo cancellation the mic hears the voice itself, so only a tap interrupts. */
  readonly voiceBargeIn: boolean;
}

export const DEFAULT_VOICE_SPEECH_CONFIG: VoiceSpeechConfig = {
  endOfTurn: DEFAULT_END_OF_TURN_CONFIG,
  bargeIn: DEFAULT_BARGE_IN_CONFIG,
  voiceBargeIn: true,
};

type ModelPart = "vad" | "asr" | "tts";

export type VoiceSpeechEvent =
  | { readonly type: "modelStatus"; readonly ready: boolean }
  | {
      readonly type: "models";
      readonly state: "downloading" | "ready" | "failed";
      readonly part: ModelPart | null;
      readonly fraction: number;
    }
  | { readonly type: "started" }
  | { readonly type: "startFailed"; readonly code: string }
  | { readonly type: "retry" }
  | { readonly type: "interruption"; readonly phase: "began" | "ended" }
  | { readonly type: "route"; readonly output: string }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "vad"; readonly speaking: boolean; readonly atMs: number }
  | { readonly type: "partial"; readonly text: string; readonly atMs: number }
  | { readonly type: "eou"; readonly text: string; readonly atMs: number }
  | {
      readonly type: "playback";
      readonly id: string;
      readonly state: "started" | "finished" | "stopped";
      readonly atMs: number;
    }
  | { readonly type: "tick"; readonly atMs: number }
  | { readonly type: "tap"; readonly atMs: number }
  | { readonly type: "holdStart"; readonly atMs: number }
  | { readonly type: "holdEnd"; readonly atMs: number }
  | { readonly type: "muted"; readonly muted: boolean; readonly atMs: number }
  | { readonly type: "finalized"; readonly text: string; readonly atMs: number }
  | { readonly type: "sent"; readonly ok: boolean; readonly atMs: number }
  | {
      readonly type: "replies";
      readonly replies: ReadonlyArray<AgentReply>;
      readonly atMs: number;
    };

export type VoiceSpeechEffect =
  | { readonly type: "checkModels" }
  | { readonly type: "download" }
  | { readonly type: "start" }
  | { readonly type: "setMuted"; readonly muted: boolean }
  | { readonly type: "finalize" }
  /** Ends the engine's utterance without sending it: echo, or words Amar muted. */
  | { readonly type: "discardTranscript" }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "speak"; readonly id: string; readonly text: string }
  | { readonly type: "stopSpeech"; readonly fadeMs: number }
  | { readonly type: "duck"; readonly level: number }
  | { readonly type: "log"; readonly line: string };

export interface VoiceSpeechStep {
  readonly state: VoiceSpeechState;
  readonly effects: ReadonlyArray<VoiceSpeechEffect>;
}

const INITIAL: VoiceSpeechState = {
  engine: { kind: "checking" },
  turn: INITIAL_END_OF_TURN_STATE,
  bargeIn: INITIAL_BARGE_IN_STATE,
  queue: EMPTY_SPEECH_QUEUE,
  volume: 1,
  overheard: "",
  sending: null,
  replies: [],
  progress: new Map(),
  turns: 0,
  timing: null,
};

/** Share of the whole download each model takes, downloaded in this order. */
const DOWNLOAD_SHARE: Record<ModelPart, readonly [number, number]> = {
  vad: [0, 0.01],
  asr: [0.01, 0.47],
  tts: [0.47, 1],
};

/**
 * A fresh engine for the session. `previous` is this session's state from before a remount:
 * what was already spoken stays spoken, and nothing it had queued plays.
 */
export function openVoiceSpeech(previous: VoiceSpeechState | null): VoiceSpeechStep {
  const state =
    previous === null
      ? INITIAL
      : {
          ...INITIAL,
          queue: bargeIn(previous.queue).queue,
          replies: previous.replies,
          progress: previous.progress,
          turns: previous.turns,
        };
  return { state, effects: [{ type: "checkModels" }] };
}

export function stepVoiceSpeech(
  state: VoiceSpeechState,
  event: VoiceSpeechEvent,
  config: VoiceSpeechConfig = DEFAULT_VOICE_SPEECH_CONFIG,
): VoiceSpeechStep {
  switch (event.type) {
    case "modelStatus":
      if (state.engine.kind !== "checking") return stay(state);
      return event.ready ? start(state) : download(state);
    case "models":
      return onModels(state, event);
    case "started":
      if (state.engine.kind !== "starting") return stay(state);
      return speakReplies({ ...state, engine: { kind: "listening" } });
    case "startFailed":
      if (state.engine.kind !== "starting" && state.engine.kind !== "checking") return stay(state);
      if (event.code === "permission_denied") return stay(withEngine(state, { kind: "micDenied" }));
      if (event.code === "models_missing") return download(state);
      return {
        state: withEngine(state, { kind: "failed" }),
        effects: [{ type: "log", line: `[voice] start failed: ${event.code}` }],
      };
    case "retry":
      if (state.engine.kind === "downloadFailed") return download(state);
      if (state.engine.kind === "failed") return check(state);
      return stay(state);
    case "interruption":
      return onInterruption(state, event.phase);
    case "route":
      return onRoute(state, event.output);
    case "error":
      return onError(state, event);
    case "muted":
      return onMuted(state, event, config);
    case "tap":
      return isSpeaking(state.queue)
        ? then(interrupt(state, config.bargeIn.fadeMs, false), (next) => ({
            state: next,
            effects: [{ type: "log", line: "[voice] tap stopped the voice" }],
          }))
        : stepTurn(state, event, config);
    case "holdStart":
    case "holdEnd":
      return stepTurn(state, event, config);
    case "tick":
      return then(stepTurn(state, event, config), (next) =>
        next.bargeIn.kind === "ducked" ? stepHeard(next, event, config) : stay(next),
      );
    case "vad":
    case "partial":
    case "eou":
      if (!isSpeaking(state.queue)) return stepTurn(state, event, config);
      return event.type === "eou" ? stay(state) : stepHeard(state, event, config);
    case "playback":
      return onPlaybackEvent(state, event, config);
    case "finalized":
      return onFinalized(state, event);
    case "sent":
      return onSent(state, event);
    case "replies":
      return speakReplies(noteFirstText({ ...state, replies: event.replies }, event.atMs));
  }
}

/** Whether the session needs clock ticks: only while a pause counts down or a barge-in waits. */
export function needsTicks(state: VoiceSpeechState): boolean {
  return state.turn.kind === "paused" || state.bargeIn.kind === "ducked";
}

/** Amar's words on screen: what is being sent, then what he is saying now. */
export function liveWords(state: VoiceSpeechState): {
  readonly sending: string | null;
  readonly current: string | null;
} {
  const current =
    (state.turn.kind === "speaking" || state.turn.kind === "paused") &&
    state.turn.transcript.trim() !== ""
      ? state.turn.transcript.trim()
      : null;
  return { sending: state.sending, current };
}

function onModels(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "models" }>,
): VoiceSpeechStep {
  if (state.engine.kind !== "downloading") return stay(state);
  if (event.state === "ready") return start(state);
  if (event.state === "failed") return stay(withEngine(state, { kind: "downloadFailed" }));
  const [from, to] = event.part === null ? [0, 1] : DOWNLOAD_SHARE[event.part];
  const fraction = Math.max(state.engine.fraction, from + (to - from) * event.fraction);
  return fraction === state.engine.fraction
    ? stay(state)
    : stay(withEngine(state, { kind: "downloading", fraction }));
}

function onInterruption(state: VoiceSpeechState, phase: "began" | "ended"): VoiceSpeechStep {
  if (phase === "ended") {
    return state.engine.kind === "interrupted"
      ? speakReplies(withEngine(state, { kind: "listening" }))
      : stay(state);
  }
  if (state.engine.kind !== "listening") return stay(state);
  return then(silence(state, 0), (next) => stay(withEngine(next, { kind: "interrupted" })));
}

function onRoute(state: VoiceSpeechState, output: string): VoiceSpeechStep {
  const log: VoiceSpeechEffect = { type: "log", line: `[voice] route: ${output}` };
  if (state.bargeIn.kind !== "ducked") return { state, effects: [log] };
  return {
    state: { ...state, bargeIn: INITIAL_BARGE_IN_STATE, volume: 1 },
    effects: [log, { type: "duck", level: 1 }],
  };
}

function onError(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "error" }>,
): VoiceSpeechStep {
  const log: VoiceSpeechEffect = {
    type: "log",
    line: `[voice] ${event.code}: ${event.message}`,
  };
  const live = state.engine.kind === "listening" || state.engine.kind === "interrupted";
  if (event.code !== "engine_restart_failed" || !live) return { state, effects: [log] };
  return then(silence(state, 0), (next) => ({
    state: withEngine(next, { kind: "failed" }),
    effects: [log],
  }));
}

function onMuted(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "muted" }>,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const hadWords = liveWords(state).current !== null;
  return then(stepTurn(state, event, config), (next) => ({
    state: next,
    effects: [
      { type: "setMuted", muted: event.muted },
      ...(event.muted && hadWords ? [{ type: "discardTranscript" } as const] : []),
    ],
  }));
}

/** Mic events while the agent speaks go to the barge-in policy, never to the end of turn. */
function stepHeard(
  state: VoiceSpeechState,
  event: BargeInEvent,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const overheard =
    event.type === "partial" && event.text.trim() !== "" ? event.text : state.overheard;
  const step = config.voiceBargeIn
    ? stepBargeIn(state.bargeIn, event, isSpeaking(state.queue), config.bargeIn)
    : { state: state.bargeIn, effects: [] };
  if (step.state === state.bargeIn && step.effects.length === 0 && overheard === state.overheard) {
    return stay(state);
  }
  let result: VoiceSpeechStep = {
    state: { ...state, bargeIn: step.state, overheard },
    effects: [],
  };
  for (const effect of step.effects) {
    result =
      effect.type === "duck"
        ? then(result, (next) => ({
            state: { ...next, volume: effect.level },
            effects: [{ type: "duck", level: effect.level }],
          }))
        : then(result, (next) =>
            then(interrupt(next, effect.fadeMs, true), (stopped) =>
              handOver(stopped, event.atMs, config),
            ),
          );
  }
  return result;
}

/** Drops every queued and playing sentence; later chunks of those replies are stale. */
function interrupt(
  state: VoiceSpeechState,
  fadeMs: number,
  amarSpeaking: boolean,
): VoiceSpeechStep {
  const discard = !amarSpeaking && state.overheard !== "";
  return {
    state: {
      ...state,
      queue: bargeIn(state.queue).queue,
      bargeIn: INITIAL_BARGE_IN_STATE,
      overheard: amarSpeaking ? state.overheard : "",
    },
    effects: [
      { type: "stopSpeech", fadeMs },
      ...(discard ? [{ type: "discardTranscript" } as const] : []),
    ],
  };
}

/** Amar talked over the agent: what the mic heard becomes his turn. */
function handOver(
  state: VoiceSpeechState,
  atMs: number,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const spoken = stepTurn(state, { type: "vad", speaking: true, atMs }, config);
  return then(spoken, (next) =>
    then(
      next.overheard.trim() === ""
        ? stay(next)
        : stepTurn(next, { type: "partial", text: next.overheard, atMs }, config),
      (heard) => stay({ ...heard, overheard: "" }),
    ),
  );
}

/** Stops speech and drops the utterance in progress, for an interruption or a failed engine. */
function silence(state: VoiceSpeechState, fadeMs: number): VoiceSpeechStep {
  const speaking = isSpeaking(state.queue);
  const hadWords = liveWords(state).current !== null || state.overheard !== "";
  return {
    state: {
      ...state,
      queue: bargeIn(state.queue).queue,
      bargeIn: INITIAL_BARGE_IN_STATE,
      overheard: "",
      turn: state.turn.kind === "muted" ? state.turn : INITIAL_END_OF_TURN_STATE,
    },
    effects: [
      ...(speaking ? [{ type: "stopSpeech", fadeMs } as const] : []),
      ...(hadWords ? [{ type: "discardTranscript" } as const] : []),
    ],
  };
}

function stepTurn(
  state: VoiceSpeechState,
  event: EndOfTurnEvent,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const before = state.turn;
  const step = stepEndOfTurn(before, event, config.endOfTurn);
  if (step.state === before && step.effects.length === 0) return stay(state);
  let result: VoiceSpeechStep = { state: { ...state, turn: step.state }, effects: [] };
  for (const effect of step.effects) {
    const words = before.kind === "speaking" || before.kind === "paused" ? before.transcript : "";
    const speechEndMs = before.kind === "paused" ? before.since : event.atMs;
    result = then(result, (next) => ({
      state: {
        ...next,
        sending: words.trim(),
        turns: next.turns + 1,
        timing: {
          turn: next.turns + 1,
          reason: effect.reason,
          speechEndMs,
          finalizedMs: null,
          sentMs: null,
          repliesBefore: null,
          replyId: null,
          firstTextMs: null,
        },
      },
      effects: [
        ...(next.timing === null ? [] : [timingLog(next.timing, null)]),
        { type: "finalize" },
      ],
    }));
  }
  return result;
}

function onFinalized(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "finalized" }>,
): VoiceSpeechStep {
  const text = event.text.trim() !== "" ? event.text.trim() : (state.sending ?? "");
  const timing = state.timing === null ? null : { ...state.timing, finalizedMs: event.atMs };
  if (text === "") return stay({ ...state, sending: null, timing });
  return { state: { ...state, sending: text, timing }, effects: [{ type: "send", text }] };
}

function onSent(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "sent" }>,
): VoiceSpeechStep {
  const next = {
    ...state,
    sending: null,
    timing:
      state.timing === null
        ? null
        : {
            ...state.timing,
            sentMs: event.atMs,
            repliesBefore: new Set(state.replies.map((reply) => reply.id)),
          },
  };
  return event.ok
    ? stay(next)
    : {
        state: next,
        effects: [{ type: "log", line: `[voice] could not queue: ${state.sending}` }],
      };
}

function noteFirstText(state: VoiceSpeechState, atMs: number): VoiceSpeechState {
  const timing = state.timing;
  if (timing === null || timing.repliesBefore === null || timing.replyId !== null) return state;
  const before = timing.repliesBefore;
  const reply = state.replies.find(
    (candidate) => !before.has(candidate.id) && /\w/.test(candidate.text),
  );
  if (reply === undefined) return state;
  return { ...state, timing: { ...timing, replyId: reply.id, firstTextMs: atMs } };
}

function onPlaybackEvent(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "playback" }>,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const timing = state.timing;
  if (
    event.state === "started" &&
    timing !== null &&
    timing.replyId !== null &&
    event.id.startsWith(`${timing.replyId}:`)
  ) {
    return {
      state: { ...state, timing: null },
      effects: [timingLog(timing, event.atMs)],
    };
  }
  const step = onPlayback(state.queue, event);
  if (step.queue === state.queue) return stay(state);
  const next: VoiceSpeechStep = {
    state: { ...state, queue: step.queue },
    effects: step.speak.map((item) => ({ type: "speak", id: item.id, text: item.text })),
  };
  return isSpeaking(step.queue)
    ? next
    : then(next, (done) => afterSpeech(done, event.atMs, config));
}

/** The agent went quiet: Amar's speech over its last words is his turn, echo is dropped. */
function afterSpeech(
  state: VoiceSpeechState,
  atMs: number,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  if (state.bargeIn.kind === "ducked") {
    return handOver({ ...state, bargeIn: INITIAL_BARGE_IN_STATE }, atMs, config);
  }
  if (state.overheard === "") return stay(state);
  const amarTalking = state.turn.kind === "speaking" || state.turn.kind === "paused";
  return {
    state: { ...state, overheard: "" },
    effects: amarTalking ? [] : [{ type: "discardTranscript" }],
  };
}

/** Queues each reply's newly safe chunks; only once the engine listens, so nothing is lost. */
function speakReplies(state: VoiceSpeechState): VoiceSpeechStep {
  if (state.engine.kind !== "listening") return stay(state);
  let queue = state.queue;
  let progress = state.progress;
  const effects: VoiceSpeechEffect[] = [];
  for (const reply of state.replies) {
    const known = progress.get(reply.id);
    if (known?.done === true) continue;
    const spoken = known?.spoken ?? 0;
    const chunks = reply.streaming
      ? nextSpeechChunks(reply.text, spoken)
      : speechChunks(reply.text).slice(spoken);
    if (chunks.length === 0 && reply.streaming) continue;
    const revision = known?.revision ?? queue.revision;
    chunks.forEach((text, index) => {
      const step = enqueue(queue, {
        id: `${reply.id}:${spoken + index}`,
        text,
        source: "front",
        revision,
      });
      queue = step.queue;
      for (const item of step.speak) effects.push({ type: "speak", id: item.id, text: item.text });
    });
    progress = new Map(progress).set(reply.id, {
      spoken: spoken + chunks.length,
      revision,
      done: !reply.streaming,
    });
  }
  if (progress === state.progress) return stay(state);
  const restore = effects.length > 0 && state.volume !== 1;
  return {
    state: { ...state, queue, progress, volume: restore ? 1 : state.volume },
    effects: restore ? [{ type: "duck", level: 1 }, ...effects] : effects,
  };
}

function timingLog(timing: TurnTiming, firstAudioMs: number | null): VoiceSpeechEffect {
  const after = (atMs: number | null) =>
    atMs === null ? "-" : `+${Math.round(atMs - timing.speechEndMs)}ms`;
  return {
    type: "log",
    line:
      `[voice] turn ${timing.turn} (${timing.reason}) from speech end: ` +
      `finalized ${after(timing.finalizedMs)}, sent ${after(timing.sentMs)}, ` +
      `first text ${after(timing.firstTextMs)}, first audio ${after(firstAudioMs)}`,
  };
}

function check(state: VoiceSpeechState): VoiceSpeechStep {
  return { state: withEngine(state, { kind: "checking" }), effects: [{ type: "checkModels" }] };
}

function download(state: VoiceSpeechState): VoiceSpeechStep {
  return {
    state: withEngine(state, { kind: "downloading", fraction: 0 }),
    effects: [{ type: "download" }],
  };
}

function start(state: VoiceSpeechState): VoiceSpeechStep {
  return { state: withEngine(state, { kind: "starting" }), effects: [{ type: "start" }] };
}

function withEngine(state: VoiceSpeechState, engine: VoiceEngineStatus): VoiceSpeechState {
  return { ...state, engine };
}

function then(
  step: VoiceSpeechStep,
  next: (state: VoiceSpeechState) => VoiceSpeechStep,
): VoiceSpeechStep {
  const after = next(step.state);
  return { state: after.state, effects: [...step.effects, ...after.effects] };
}

function stay(state: VoiceSpeechState): VoiceSpeechStep {
  return { state, effects: [] };
}
