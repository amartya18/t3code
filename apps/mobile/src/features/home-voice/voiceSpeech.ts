import type { VoiceModelPart } from "../../../modules/t3-voice-mode";
import { goodbyeReply, withoutEndCall } from "./endCall";
import {
  dropLiveTurn,
  INITIAL_TURN_STATE,
  isTurnOpen,
  stepTurn,
  type TurnConfig,
  type TurnEffect,
  type TurnEvent,
  type TurnState,
} from "./endOfTurn";
import { nextSpeechChunks, speechChunks } from "./speakable";
import {
  bargeIn,
  EMPTY_SPEECH_QUEUE,
  enqueue,
  isSpeaking,
  onPlayback,
  type SpeechItem,
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

/** Kept until the thread has it. */
export interface OwnLine {
  readonly text: string;
  /** The outbox, then the thread, hold the line under this id. */
  readonly messageId: string;
}

/** How much of a reply the transcript shows: the chunks that started playing, or all of it. */
export type ReplyShown =
  | { readonly kind: "spoken"; readonly text: string }
  | { readonly kind: "whole" };

const WHOLE: ReplyShown = { kind: "whole" };

interface ReplyProgress {
  readonly spoken: number;
  /** Chunks that played to the end; once every chunk of a finished reply has, it shows whole. */
  readonly played: number;
  /** The queue revision when its first chunk was queued; an interrupt makes the rest stale. */
  readonly revision: number;
  /** Complete and fully queued, so later thread updates skip it. */
  readonly done: boolean;
}

/** The call ends after the agent's goodbye to Amar has played. */
type CallEnding =
  | { readonly kind: "open" }
  | { readonly kind: "goodbye"; readonly replyId: string }
  | { readonly kind: "ended" };

const OPEN: CallEnding = { kind: "open" };

/** A voice that started over the agent: the agent ducks, and stops if the voice lasts. */
interface Interrupt {
  /** When JS heard it start; the confirm counts from here. */
  readonly heardAtMs: number;
  /** Engine time it really started, where the user's turn begins if it stops the agent. */
  readonly speechMs: number;
}

interface TurnTiming {
  readonly turn: number;
  readonly speechEndMs: number;
  readonly decidedMs: number;
  readonly probability: number | null;
  readonly waited: boolean;
  readonly transcribedMs: number | null;
  readonly sentMs: number | null;
  /** Replies already in the thread when the message was sent; the next new one answers it. */
  readonly repliesBefore: ReadonlySet<string> | null;
  readonly replyId: string | null;
  readonly firstTextMs: number | null;
}

export interface VoiceSpeechState {
  readonly engine: VoiceEngineStatus;
  readonly turn: TurnState;
  readonly interrupt: Interrupt | null;
  readonly queue: SpeechQueue;
  readonly volume: number;
  readonly own: OwnLine | null;
  readonly replies: ReadonlyArray<AgentReply>;
  readonly progress: ReadonlyMap<string, ReplyProgress>;
  readonly shown: ReadonlyMap<string, ReplyShown>;
  readonly ending: CallEnding;
  readonly timing: TurnTiming | null;
  /** When the speech queue last moved, or null until the next tick stamps it. */
  readonly speechMovedAtMs: number | null;
}

export interface VoiceSpeechConfig extends TurnConfig {
  /** Off without echo cancellation, where the mic hears the agent's own voice. */
  readonly voiceBargeIn: boolean;
}

export type VoiceSpeechEvent =
  | { readonly type: "modelStatus"; readonly ready: boolean }
  | {
      readonly type: "models";
      readonly state: "downloading" | "ready" | "failed";
      readonly part: VoiceModelPart | null;
      readonly fraction: number;
    }
  | { readonly type: "started" }
  | { readonly type: "startFailed"; readonly code: string }
  | { readonly type: "retry" }
  | { readonly type: "interruption"; readonly phase: "began" | "ended" }
  | { readonly type: "route"; readonly output: string }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | TurnEvent
  | {
      readonly type: "playback";
      readonly id: string;
      readonly state: "started" | "finished" | "stopped";
      readonly atMs: number;
    }
  | {
      readonly type: "sent";
      readonly ok: boolean;
      readonly messageId: string;
      readonly atMs: number;
    }
  | {
      readonly type: "thread";
      readonly replies: ReadonlyArray<AgentReply>;
      readonly userMessageIds: ReadonlySet<string>;
      /** Amar's newest line in the thread; Home's updates are not his. */
      readonly lastLine: string | null;
      readonly atMs: number;
    };

export type VoiceSpeechEffect =
  | { readonly type: "checkModels" }
  | { readonly type: "download" }
  | { readonly type: "start" }
  | { readonly type: "setMuted"; readonly muted: boolean }
  | Extract<TurnEffect, { type: "scoreTurn" | "transcribe" }>
  | { readonly type: "send"; readonly text: string; readonly messageId: string }
  | { readonly type: "speak"; readonly id: string; readonly text: string }
  | { readonly type: "stopSpeech"; readonly fadeMs: number }
  | { readonly type: "duck"; readonly level: number }
  /** The mic just started hearing Amar: the call's only cue, since it opens silent. */
  | { readonly type: "ready" }
  | { readonly type: "hangUp" }
  | { readonly type: "log"; readonly line: string };

export interface VoiceSpeechStep {
  readonly state: VoiceSpeechState;
  readonly effects: ReadonlyArray<VoiceSpeechEffect>;
}

const INITIAL: VoiceSpeechState = {
  engine: { kind: "checking" },
  turn: INITIAL_TURN_STATE,
  interrupt: null,
  queue: EMPTY_SPEECH_QUEUE,
  volume: 1,
  own: null,
  replies: [],
  progress: new Map(),
  shown: new Map(),
  ending: OPEN,
  timing: null,
  speechMovedAtMs: null,
};

/** Older than any queue revision, so the queue drops every chunk of a reply marked with it. */
const STALE_REVISION = -1;

/** Longer than any one chunk takes to synthesize and play, so only a lost playback event trips it. */
const SPEECH_STALL_MS = 30_000;

const DUCK_LEVEL = 0.25;
const STOP_FADE_MS = 80;
/** A voice still on this long after the detector reported it stops the agent. */
const INTERRUPT_CONFIRM_MS = 250;

/** Share of the whole download each model takes, downloaded in this order. */
const DOWNLOAD_SHARE: Record<VoiceModelPart, readonly [number, number]> = {
  vad: [0, 0.005],
  asr: [0.005, 0.845],
  turn: [0.845, 0.87],
  tts: [0.87, 1],
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
          turn: { ...INITIAL_TURN_STATE, count: previous.turn.count },
          queue: bargeIn(previous.queue).queue,
          replies: previous.replies,
          progress: previous.progress,
          shown: new Map(previous.replies.map((reply) => [reply.id, WHOLE])),
        };
  return { state, effects: [{ type: "checkModels" }] };
}

export function stepVoiceSpeech(
  state: VoiceSpeechState,
  event: VoiceSpeechEvent,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const step = stepWatched(state, event, config);
  const shown = speechOff(step.state.engine) ? showAll(step.state) : showUnheard(step.state);
  return hangUpAfterGoodbye(shown === step.state ? step : { ...step, state: shown });
}

/** Hangs up once the goodbye has played, or at once when the voice can't play it. Amar talking keeps the call. */
function hangUpAfterGoodbye(step: VoiceSpeechStep): VoiceSpeechStep {
  const { state } = step;
  if (state.ending.kind !== "goodbye") return step;
  if (amarAhead(state)) return { ...step, state: { ...state, ending: OPEN } };
  const progress = state.progress.get(state.ending.replyId);
  if (!speechOff(state.engine) && (progress === undefined || !allPlayed(progress))) return step;
  return {
    state: { ...state, ending: { kind: "ended" } },
    effects: [...step.effects, { type: "hangUp" }],
  };
}

/** Amar is talking, or said something the thread doesn't have yet. */
function amarAhead(state: VoiceSpeechState): boolean {
  return isTurnOpen(state.turn) || state.own !== null;
}

/** The engine won't voice replies now, so the transcript is the only way to get them. */
function speechOff(engine: VoiceEngineStatus): boolean {
  return engine.kind !== "checking" && engine.kind !== "starting" && engine.kind !== "listening";
}

/** A reply that will never play a word shows whole; one cut partway keeps what played. */
function showUnheard(state: VoiceSpeechState): VoiceSpeechState {
  let shown = state.shown;
  for (const [id, progress] of state.progress) {
    if (progress.revision < state.queue.revision && !shown.has(id)) {
      shown = new Map(shown).set(id, WHOLE);
    }
  }
  return shown === state.shown ? state : { ...state, shown };
}

function showAll(state: VoiceSpeechState): VoiceSpeechState {
  if (state.replies.every((reply) => state.shown.get(reply.id) === WHOLE)) return state;
  const shown = new Map(state.shown);
  for (const reply of state.replies) shown.set(reply.id, WHOLE);
  return { ...state, shown };
}

function stepWatched(
  state: VoiceSpeechState,
  event: VoiceSpeechEvent,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  if (event.type === "tick" && isSpeaking(state.queue)) {
    if (state.speechMovedAtMs === null) {
      return stepSpeech({ ...state, speechMovedAtMs: event.atMs }, event, config);
    }
    if (event.atMs - state.speechMovedAtMs > SPEECH_STALL_MS) {
      return then(stopSpeaking(state, 0), (next) => ({
        state: next,
        effects: [
          { type: "log", line: "[voice] speech stalled with no playback event; dropped it" },
        ],
      }));
    }
  }
  const step = stepSpeech(state, event, config);
  if (step.state.queue.sent === state.queue.sent) return step;
  const movedAt = "atMs" in event ? event.atMs : null;
  return { ...step, state: { ...step.state, speechMovedAtMs: movedAt } };
}

function stepSpeech(
  state: VoiceSpeechState,
  event: VoiceSpeechEvent,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  switch (event.type) {
    case "modelStatus":
      if (state.engine.kind !== "checking") return stay(state);
      return event.ready ? start(state) : download(state);
    case "models":
      return onModels(state, event);
    case "started":
      if (state.engine.kind !== "starting") return stay(state);
      return then(
        { state: { ...state, engine: { kind: "listening" } }, effects: [{ type: "ready" }] },
        speakReplies,
      );
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
    case "tick":
      return then(confirmInterrupt(state, event.atMs, config), (next) =>
        withTurn(next, event, config),
      );
    case "vad":
      return isSpeaking(state.queue)
        ? onVoiceOverAgent(state, event, config)
        : withTurn(state, event, config);
    case "scored":
    case "transcribed":
      return withTurn(state, event, config);
    case "playback":
      return onPlaybackEvent(state, event, config);
    case "sent":
      return onSent(state, event);
    case "thread":
      return speakReplies(
        noteGoodbye(
          noteFirstText(
            {
              ...state,
              replies: event.replies,
              own:
                state.own !== null && event.userMessageIds.has(state.own.messageId)
                  ? null
                  : state.own,
            },
            event.atMs,
          ),
          event.lastLine,
        ),
      );
  }
}

export function needsTicks(state: VoiceSpeechState): boolean {
  return state.turn.live.kind === "paused" || isSpeaking(state.queue);
}

/** Whether the mic hears Amar's voice in his turn; sound over the agent may be its own echo. */
export function isHearing(state: VoiceSpeechState): boolean {
  return state.turn.live.kind === "speaking";
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
  return then(silence(state), (next) => stay(withEngine(next, { kind: "interrupted" })));
}

function onRoute(state: VoiceSpeechState, output: string): VoiceSpeechStep {
  const log: VoiceSpeechEffect = { type: "log", line: `[voice] route: ${output}` };
  if (state.interrupt === null) return { state, effects: [log] };
  return {
    state: { ...state, interrupt: null, volume: 1 },
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
  return then(silence(state), (next) => ({
    state: withEngine(next, { kind: "failed" }),
    effects: [log],
  }));
}

/** A muted mic sends no end to a voice it was hearing, so a duck it started is undone here. */
function onMuted(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "muted" }>,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const ducked = state.interrupt !== null;
  const settled = ducked ? { ...state, interrupt: null, volume: 1 } : state;
  return then(withTurn(settled, event, config), (next) => ({
    state: next,
    effects: [
      { type: "setMuted", muted: event.muted },
      ...(ducked ? [{ type: "duck", level: 1 } as const] : []),
    ],
  }));
}

function onVoiceOverAgent(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "vad" }>,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  if (!config.voiceBargeIn) return stay(state);
  const { interrupt } = state;
  if (event.speaking) {
    if (interrupt !== null) return stay(state);
    return {
      state: {
        ...state,
        interrupt: { heardAtMs: event.atMs, speechMs: event.speechMs },
        volume: DUCK_LEVEL,
      },
      effects: [{ type: "duck", level: DUCK_LEVEL }],
    };
  }
  if (interrupt === null) return stay(state);
  return {
    state: { ...state, interrupt: null, volume: 1 },
    effects: [{ type: "duck", level: 1 }, interruptLog(interrupt, "restore", event.atMs, config)],
  };
}

function confirmInterrupt(
  state: VoiceSpeechState,
  atMs: number,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const { interrupt } = state;
  if (interrupt === null || atMs - interrupt.heardAtMs < INTERRUPT_CONFIRM_MS) return stay(state);
  const stopped = stopSpeaking(state, STOP_FADE_MS);
  return then(
    { ...stopped, effects: [...stopped.effects, interruptLog(interrupt, "stop", atMs, config)] },
    (next) => handOver(next, interrupt, atMs, config),
  );
}

function handOver(
  state: VoiceSpeechState,
  interrupt: Interrupt,
  atMs: number,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  return withTurn(
    state,
    { type: "vad", speaking: true, speechMs: interrupt.speechMs, atMs },
    config,
  );
}

function interruptLog(
  interrupt: Interrupt,
  outcome: "stop" | "restore" | "end",
  atMs: number,
  config: VoiceSpeechConfig,
): VoiceSpeechEffect {
  const onsetMs = interrupt.heardAtMs - config.vad.minSpeechMs;
  const after = (ms: number) => `+${Math.round(ms - onsetMs)}ms`;
  return {
    type: "log",
    line: `[voice] interrupt from speech onset: duck ${after(interrupt.heardAtMs)}, ${outcome} ${after(atMs)}`,
  };
}

/** Drops every queued and playing sentence; later chunks of those replies are stale. */
function stopSpeaking(state: VoiceSpeechState, fadeMs: number): VoiceSpeechStep {
  return {
    state: { ...state, queue: bargeIn(state.queue).queue, interrupt: null },
    effects: [{ type: "stopSpeech", fadeMs }],
  };
}

/** Stops speech and drops the turn in progress, for an audio interruption or a failed engine. */
function silence(state: VoiceSpeechState): VoiceSpeechStep {
  const quiet = { ...state, turn: dropLiveTurn(state.turn) };
  return isSpeaking(state.queue) ? stopSpeaking(quiet, 0) : stay(quiet);
}

/** The user's turn steps; once it no longer holds them, replies that waited for it may play. */
function withTurn(
  state: VoiceSpeechState,
  event: TurnEvent,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const step = stepTurn(state.turn, event, config);
  if (step.state === state.turn && step.effects.length === 0) return stay(state);
  let result: VoiceSpeechStep = { state: { ...state, turn: step.state }, effects: [] };
  for (const effect of step.effects) {
    result = then(result, (next) => onTurnEffect(next, effect, event.atMs, config));
  }
  return isTurnOpen(state.turn) && !isTurnOpen(result.state.turn)
    ? then(result, speakReplies)
    : result;
}

function onTurnEffect(
  state: VoiceSpeechState,
  effect: TurnEffect,
  atMs: number,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  switch (effect.type) {
    case "scoreTurn":
    case "transcribe":
      return { state, effects: [effect] };
    case "score":
      return { state, effects: [{ type: "log", line: scoreLine(effect) }] };
    case "decided":
      return {
        state: {
          ...state,
          timing: {
            turn: effect.turn,
            speechEndMs: effect.endedAtMs - config.vad.minSilenceMs,
            decidedMs: atMs,
            probability: effect.probability,
            waited: effect.waited,
            transcribedMs: null,
            sentMs: null,
            repliesBefore: null,
            replyId: null,
            firstTextMs: null,
          },
        },
        effects: state.timing === null ? [] : [timingLog(state.timing, null)],
      };
    case "heard": {
      const timing =
        state.timing?.turn === effect.turn
          ? { ...state.timing, transcribedMs: atMs }
          : state.timing;
      if (effect.text === "") {
        const unheard = timing !== null && timing.turn === effect.turn;
        return {
          state: { ...state, timing: unheard ? null : timing },
          effects: unheard ? [timingLog(timing, "no words")] : [],
        };
      }
      return {
        state: { ...state, own: { text: effect.text, messageId: effect.messageId }, timing },
        effects: [{ type: "send", text: effect.text, messageId: effect.messageId }],
      };
    }
  }
}

function scoreLine(effect: Extract<TurnEffect, { type: "score" }>): string {
  const score = `[voice] turn ${effect.turn} Smart Turn ${effect.probability.toFixed(2)}`;
  return effect.silenceMs === null
    ? `${score} came after the pause ended: ignore`
    : `${score} after ${(effect.silenceMs / 1000).toFixed(1)} s silence: ${effect.decision}`;
}

function onSent(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "sent" }>,
): VoiceSpeechStep {
  const failed = !event.ok && state.own?.messageId === event.messageId;
  const next = {
    ...state,
    own: failed ? null : state.own,
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
    : { state: next, effects: [{ type: "log", line: "[voice] could not queue a line" }] };
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

function noteGoodbye(state: VoiceSpeechState, lastLine: string | null): VoiceSpeechState {
  if (state.ending.kind === "ended") return state;
  const replyId = amarAhead(state) ? null : goodbyeReply(state.replies, lastLine);
  const current = state.ending.kind === "goodbye" ? state.ending.replyId : null;
  if (replyId === current) return state;
  return { ...state, ending: replyId === null ? OPEN : { kind: "goodbye", replyId } };
}

function onPlaybackEvent(
  state: VoiceSpeechState,
  event: Extract<VoiceSpeechEvent, { type: "playback" }>,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const item = state.queue.sent.find((candidate) => candidate.id === event.id);
  const revealed = item === undefined ? state : reveal(state, item, event.state);
  const timing = revealed.timing;
  if (
    event.state === "started" &&
    timing !== null &&
    timing.replyId !== null &&
    event.id.startsWith(`${timing.replyId}:`)
  ) {
    return {
      state: { ...revealed, timing: null },
      effects: [timingLog(timing, event.atMs)],
    };
  }
  const step = onPlayback(revealed.queue, event);
  if (step.queue === revealed.queue) return stay(revealed);
  const next: VoiceSpeechStep = {
    state: { ...revealed, queue: step.queue },
    effects: step.speak.map((item) => ({ type: "speak", id: item.id, text: item.text })),
  };
  return isSpeaking(step.queue)
    ? next
    : then(next, (done) => afterSpeech(done, event.atMs, config));
}

/** A chunk that starts playing shows; a reply whose every chunk played shows whole. */
function reveal(
  state: VoiceSpeechState,
  item: SpeechItem,
  playback: "started" | "finished" | "stopped",
): VoiceSpeechState {
  const replyId = replyOf(item.id);
  if (playback === "stopped") return state;
  if (playback === "started") {
    const shown = state.shown.get(replyId);
    if (shown?.kind === "whole") return state;
    const text = shown === undefined ? item.text : `${shown.text} ${item.text}`;
    return { ...state, shown: new Map(state.shown).set(replyId, { kind: "spoken", text }) };
  }
  const progress = state.progress.get(replyId);
  if (progress === undefined) return state;
  const played = { ...progress, played: progress.played + 1 };
  return {
    ...state,
    progress: new Map(state.progress).set(replyId, played),
    shown: allPlayed(played) ? new Map(state.shown).set(replyId, WHOLE) : state.shown,
  };
}

function allPlayed(progress: ReplyProgress): boolean {
  return progress.done && progress.played === progress.spoken;
}

/** The agent went quiet under a voice it ducked for: that voice is the user's turn. */
function afterSpeech(
  state: VoiceSpeechState,
  atMs: number,
  config: VoiceSpeechConfig,
): VoiceSpeechStep {
  const { interrupt } = state;
  if (interrupt === null) return stay(state);
  return then(
    {
      state: { ...state, interrupt: null },
      effects: [interruptLog(interrupt, "end", atMs, config)],
    },
    (next) => handOver(next, interrupt, atMs, config),
  );
}

/** A reply the user has talked past, by speaking a line the thread doesn't have yet, never plays. */
function speakReplies(state: VoiceSpeechState): VoiceSpeechStep {
  if (state.engine.kind !== "listening" || isTurnOpen(state.turn)) return stay(state);
  const ahead = state.own !== null;
  let queue = state.queue;
  let progress = state.progress;
  let shown = state.shown;
  const effects: VoiceSpeechEffect[] = [];
  for (const reply of state.replies) {
    const known = progress.get(reply.id);
    if (known?.done === true) continue;
    const spoken = known?.spoken ?? 0;
    const words = withoutEndCall(reply.text);
    const chunks = reply.streaming
      ? nextSpeechChunks(words, spoken)
      : speechChunks(words).slice(spoken);
    if (chunks.length === 0 && reply.streaming) continue;
    const revision = ahead ? STALE_REVISION : (known?.revision ?? queue.revision);
    chunks.forEach((text, index) => {
      const step = enqueue(queue, {
        id: chunkId(reply.id, spoken + index),
        text,
        source: "front",
        revision,
      });
      queue = step.queue;
      for (const item of step.speak) effects.push({ type: "speak", id: item.id, text: item.text });
    });
    const next = {
      spoken: spoken + chunks.length,
      played: known?.played ?? 0,
      revision,
      done: !reply.streaming,
    };
    progress = new Map(progress).set(reply.id, next);
    if (allPlayed(next)) shown = new Map(shown).set(reply.id, WHOLE);
  }
  if (progress === state.progress) return stay(state);
  const restore = effects.length > 0 && state.volume !== 1 && state.interrupt === null;
  return {
    state: { ...state, queue, progress, shown, volume: restore ? 1 : state.volume },
    effects: restore ? [{ type: "duck", level: 1 }, ...effects] : effects,
  };
}

/** `firstAudioMs` is null when the reply never played, and "no words" when the turn had none. */
function timingLog(
  timing: TurnTiming,
  firstAudioMs: number | null | "no words",
): VoiceSpeechEffect {
  const after = (atMs: number | null) =>
    atMs === null ? "-" : `+${Math.round(atMs - timing.speechEndMs)}ms`;
  const score = timing.probability === null ? "no score" : timing.probability.toFixed(2);
  const smartTurn = `Smart Turn ${score}${timing.waited ? ", waited" : ""}`;
  const replied =
    firstAudioMs === "no words"
      ? firstAudioMs
      : `sent ${after(timing.sentMs)}, first text ${after(timing.firstTextMs)}, ` +
        `first audio ${after(firstAudioMs)}`;
  return {
    type: "log",
    line:
      `[voice] turn ${timing.turn} from speech end: decided ${after(timing.decidedMs)} ` +
      `(${smartTurn}), transcribed ${after(timing.transcribedMs)}, ${replied}`,
  };
}

function chunkId(replyId: string, chunk: number): string {
  return `${replyId}:${chunk}`;
}

function replyOf(id: string): string {
  return id.slice(0, id.lastIndexOf(":"));
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
