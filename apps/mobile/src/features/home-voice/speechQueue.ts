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

export interface BargeInConfig {
  /** How long speech must go on, with words heard, before the voice stops. */
  readonly confirmMs: number;
  readonly duckLevel: number;
  readonly fadeMs: number;
}

export const DEFAULT_BARGE_IN_CONFIG: BargeInConfig = {
  confirmMs: 300,
  duckLevel: 0.25,
  fadeMs: 80,
};

export type BargeInState =
  | { readonly kind: "listening" }
  | { readonly kind: "ducked"; readonly since: number; readonly heardWords: boolean };

export type BargeInEvent =
  | { readonly type: "vad"; readonly speaking: boolean; readonly atMs: number }
  | { readonly type: "partial"; readonly text: string; readonly atMs: number }
  | { readonly type: "tick"; readonly atMs: number };

/** `interrupt` means: call `bargeIn` on the queue, then the engine's `stopSpeech(fadeMs)`. */
export type BargeInEffect =
  | { readonly type: "duck"; readonly level: number }
  | { readonly type: "interrupt"; readonly fadeMs: number };

export const INITIAL_BARGE_IN_STATE: BargeInState = { kind: "listening" };

export function stepBargeIn(
  state: BargeInState,
  event: BargeInEvent,
  speaking: boolean,
  config: BargeInConfig = DEFAULT_BARGE_IN_CONFIG,
): { readonly state: BargeInState; readonly effects: ReadonlyArray<BargeInEffect> } {
  if (state.kind === "listening") {
    return event.type === "vad" && event.speaking && speaking
      ? {
          state: { kind: "ducked", since: event.atMs, heardWords: false },
          effects: [{ type: "duck", level: config.duckLevel }],
        }
      : { state, effects: [] };
  }
  if (!speaking || (event.type === "vad" && !event.speaking)) {
    return { state: INITIAL_BARGE_IN_STATE, effects: [{ type: "duck", level: 1 }] };
  }
  const heardWords = state.heardWords || (event.type === "partial" && event.text.trim() !== "");
  if (heardWords && event.atMs - state.since >= config.confirmMs) {
    return {
      state: INITIAL_BARGE_IN_STATE,
      effects: [{ type: "interrupt", fadeMs: config.fadeMs }],
    };
  }
  return { state: { ...state, heardWords }, effects: [] };
}
