import { WORDS_LAG_MS } from "./endOfTurn";

export type SpeechSource = "front" | "home";

export interface SpeechItem {
  readonly id: string;
  readonly text: string;
  readonly source: SpeechSource;
  /** The queue revision when the reply began; a barge-in makes every older item stale. */
  readonly revision: number;
}

export interface SpeechQueue {
  readonly revision: number;
  /** Handed to the engine with `speak`, in play order; the head may be playing. */
  readonly sent: ReadonlyArray<SpeechItem>;
  /** Waiting in JS, where a home item can still go ahead of front items. */
  readonly waiting: ReadonlyArray<SpeechItem>;
}

export interface SpeechQueueStep {
  readonly queue: SpeechQueue;
  /** Items to pass to the engine's `speak`, in order. */
  readonly speak: ReadonlyArray<SpeechItem>;
}

export type PlaybackEvent = {
  readonly id: string;
  readonly state: "started" | "finished" | "stopped";
};

export const EMPTY_SPEECH_QUEUE: SpeechQueue = { revision: 0, sent: [], waiting: [] };

/** Kokoro voices one clip per call, so the engine synthesizes this many ahead to avoid gaps. */
const LOOKAHEAD = 3;

export function enqueue(queue: SpeechQueue, item: SpeechItem): SpeechQueueStep {
  if (item.revision < queue.revision) return { queue, speak: [] };
  const firstFront = queue.waiting.findIndex((waiting) => waiting.source === "front");
  const at = item.source === "home" && firstFront !== -1 ? firstFront : queue.waiting.length;
  return fill({
    ...queue,
    waiting: [...queue.waiting.slice(0, at), item, ...queue.waiting.slice(at)],
  });
}

export function onPlayback(queue: SpeechQueue, event: PlaybackEvent): SpeechQueueStep {
  if (event.state === "started") return { queue, speak: [] };
  return fill({ ...queue, sent: queue.sent.filter((item) => item.id !== event.id) });
}

/** Drops everything queued and returns the ids the engine was given, to stop. */
export function bargeIn(queue: SpeechQueue): {
  readonly queue: SpeechQueue;
  readonly stop: ReadonlyArray<string>;
} {
  return {
    queue: { revision: queue.revision + 1, sent: [], waiting: [] },
    stop: queue.sent.map((item) => item.id),
  };
}

export function isSpeaking(queue: SpeechQueue): boolean {
  return queue.sent.length > 0;
}

function fill(queue: SpeechQueue): SpeechQueueStep {
  const room = Math.max(0, LOOKAHEAD - queue.sent.length);
  const speak = queue.waiting.slice(0, room);
  return {
    queue: { ...queue, sent: [...queue.sent, ...speak], waiting: queue.waiting.slice(room) },
    speak,
  };
}

export const INTERRUPT_MODES = ["anySound", "words", "hybrid"] as const;
/**
 * What stops the agent's voice when Amar talks over it: any sound the voice detector hears, only
 * his words, or a duck at the sound that becomes a stop at his words.
 */
export type InterruptMode = (typeof INTERRUPT_MODES)[number];

export const RECOVERY_MODES = ["resume", "restart", "smart"] as const;
/**
 * What a false alarm, a sound with no words, does to the voice it cut: play on, play the cut chunk
 * again from its start, or play on after a short pause and restart after a long one.
 */
export type RecoveryMode = (typeof RECOVERY_MODES)[number];

export interface BargeInConfig {
  readonly mode: InterruptMode;
  readonly recovery: RecoveryMode;
  /** `smart` restarts the chunk after a pause this long or longer. */
  readonly smartCutoffMs: number;
  readonly duckLevel: number;
  readonly fadeMs: number;
  /** How long after a sound starts words may still come; a quiet sound without them is a false alarm. */
  readonly coughMs: number;
}

export const DEFAULT_BARGE_IN_CONFIG: BargeInConfig = {
  mode: "hybrid",
  recovery: "smart",
  smartCutoffMs: 1_000,
  duckLevel: 0.25,
  fadeMs: 80,
  coughMs: 600,
};

export interface BargeInState {
  /** When the voice detector last went quiet; null while it hears sound. */
  readonly quietSinceMs: number | null;
  /** When the detector began hearing the sound that no stop or recovery has settled yet. */
  readonly onsetMs: number | null;
  readonly duckedMs: number | null;
}

export type BargeInEvent =
  | { readonly type: "vad"; readonly speaking: boolean; readonly atMs: number }
  | { readonly type: "partial"; readonly text: string; readonly atMs: number }
  | { readonly type: "tick"; readonly atMs: number };

/**
 * `interrupt` means: call `bargeIn` on the queue, then the engine's `stopSpeech(fadeMs)`; with
 * `awaitWords` it may be a false alarm, so the cut speech is kept to play again. `replay` stops the
 * voice and plays the cut chunk again from its start.
 */
export type BargeInEffect =
  | { readonly type: "duck"; readonly level: number }
  | { readonly type: "interrupt"; readonly fadeMs: number; readonly awaitWords: boolean }
  | { readonly type: "replay"; readonly fadeMs: number }
  | { readonly type: "log"; readonly line: string };

export interface BargeInStep {
  readonly state: BargeInState;
  readonly effects: ReadonlyArray<BargeInEffect>;
}

export const INITIAL_BARGE_IN_STATE: BargeInState = {
  quietSinceMs: Number.NEGATIVE_INFINITY,
  onsetMs: null,
  duckedMs: null,
};

/** Mic events while the agent's voice plays. A word over it stops it in every mode. */
export function stepBargeIn(
  state: BargeInState,
  event: BargeInEvent,
  config: BargeInConfig = DEFAULT_BARGE_IN_CONFIG,
): BargeInStep {
  const settled = { ...state, onsetMs: null, duckedMs: null };
  switch (event.type) {
    case "partial":
      if (event.text.trim() === "") return { state, effects: [] };
      return {
        state: settled,
        effects: [
          { type: "interrupt", fadeMs: config.fadeMs, awaitWords: false },
          interruptLog(config.mode, state, event.atMs, "stop", event.atMs),
        ],
      };
    case "vad": {
      if (!event.speaking) return { state: { ...state, quietSinceMs: event.atMs }, effects: [] };
      const heard = {
        ...state,
        quietSinceMs: null,
        onsetMs: state.duckedMs === null ? event.atMs : state.onsetMs,
      };
      if (config.mode === "anySound") {
        return {
          state: { ...heard, onsetMs: null },
          effects: [
            { type: "interrupt", fadeMs: config.fadeMs, awaitWords: true },
            interruptLog(config.mode, heard, null, "stop", event.atMs),
          ],
        };
      }
      if (config.mode === "words" || state.duckedMs !== null) return { state: heard, effects: [] };
      return {
        state: { ...heard, duckedMs: event.atMs },
        effects: [{ type: "duck", level: config.duckLevel }],
      };
    }
    case "tick": {
      const { onsetMs, duckedMs, quietSinceMs } = state;
      if (
        duckedMs === null ||
        !wordsTooLate(onsetMs ?? duckedMs, quietSinceMs, event.atMs, config)
      ) {
        return { state, effects: [] };
      }
      const pausedMs = event.atMs - duckedMs;
      const action = recoveryAction(config, pausedMs, false);
      return {
        state: settled,
        effects: [
          action === "restore"
            ? { type: "duck", level: 1 }
            : { type: "replay", fadeMs: config.fadeMs },
          interruptLog(config.mode, state, null, action, event.atMs),
          recoveryLog(config, pausedMs, action),
        ],
      };
    }
  }
}

/**
 * No words came for the sound: it's quiet, its window is over, and Parakeet's lag behind the
 * sound has passed.
 */
export function wordsTooLate(
  onsetMs: number,
  quietSinceMs: number | null,
  atMs: number,
  config: BargeInConfig,
): boolean {
  return (
    quietSinceMs !== null && atMs - onsetMs >= config.coughMs && atMs - quietSinceMs >= WORDS_LAG_MS
  );
}

/** A stopped chunk can't go on from where it stopped, so it always plays again from its start. */
export function recoveryAction(
  config: BargeInConfig,
  pausedMs: number,
  stopped: boolean,
): "restore" | "replay" {
  if (stopped || config.recovery === "restart") return "replay";
  if (config.recovery === "resume") return "restore";
  return pausedMs < config.smartCutoffMs ? "restore" : "replay";
}

export function recoveryLog(
  config: BargeInConfig,
  pausedMs: number,
  action: "restore" | "replay",
): Extract<BargeInEffect, { type: "log" }> {
  const did = action === "restore" ? "restored volume" : "replayed the chunk";
  return {
    type: "log",
    line: `[voice] recover ${config.mode} ${config.recovery}: paused ${Math.round(pausedMs)}ms, ${did}`,
  };
}

function interruptLog(
  mode: InterruptMode,
  state: BargeInState,
  wordMs: number | null,
  outcome: "stop" | "restore" | "replay",
  atMs: number,
): BargeInEffect {
  const from = state.onsetMs ?? wordMs ?? atMs;
  const after = (ms: number | null) => {
    if (ms === null) return "none";
    const delta = Math.round(ms - from);
    return `${delta < 0 ? "" : "+"}${delta}ms`;
  };
  return {
    type: "log",
    line:
      `[voice] interrupt ${mode}: onset ${after(state.onsetMs)}, word ${after(wordMs)}, ` +
      `duck ${after(state.duckedMs)}, ${outcome} ${after(atMs)}`,
  };
}
