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
  readonly duckLevel: number;
  readonly fadeMs: number;
}

export const DEFAULT_BARGE_IN_CONFIG: BargeInConfig = {
  duckLevel: 0.25,
  fadeMs: 80,
};

export type BargeInState = { readonly kind: "listening" } | { readonly kind: "ducked" };

export type BargeInEvent =
  | { readonly type: "vad"; readonly speaking: boolean; readonly atMs: number }
  | { readonly type: "partial"; readonly text: string; readonly atMs: number };

/** `interrupt` means: call `bargeIn` on the queue, then the engine's `stopSpeech(fadeMs)`. */
export type BargeInEffect =
  | { readonly type: "duck"; readonly level: number }
  | { readonly type: "interrupt"; readonly fadeMs: number };

export const INITIAL_BARGE_IN_STATE: BargeInState = { kind: "listening" };

/**
 * Any word Amar says over the voice stops it. On the speaker his voice without words only ducks
 * it, since that can be the voice's own echo; on headphones the mic can't hear the voice, so his
 * voice alone stops it.
 */
export function stepBargeIn(
  state: BargeInState,
  event: BargeInEvent,
  input: { readonly speaking: boolean; readonly headphones: boolean },
  config: BargeInConfig = DEFAULT_BARGE_IN_CONFIG,
): { readonly state: BargeInState; readonly effects: ReadonlyArray<BargeInEffect> } {
  const interrupt = {
    state: INITIAL_BARGE_IN_STATE,
    effects: [{ type: "interrupt", fadeMs: config.fadeMs }],
  } as const;
  const unduck = { state: INITIAL_BARGE_IN_STATE, effects: [{ type: "duck", level: 1 }] } as const;
  const stay = { state, effects: [] };
  if (!input.speaking) return state.kind === "ducked" ? unduck : stay;
  if (event.type === "partial") return event.text.trim() === "" ? stay : interrupt;
  if (!event.speaking) return state.kind === "ducked" ? unduck : stay;
  if (input.headphones) return interrupt;
  return state.kind === "ducked"
    ? stay
    : { state: { kind: "ducked" }, effects: [{ type: "duck", level: config.duckLevel }] };
}
