export interface EndOfTurnConfig {
  readonly pauseMs: number;
  readonly floorMs: number;
  /** The longest a held pause waits before it sends anyway. */
  readonly ceilingMs: number;
  readonly earlySend: boolean;
}

export const DEFAULT_END_OF_TURN_CONFIG: EndOfTurnConfig = {
  pauseMs: 3_000,
  floorMs: 500,
  ceilingMs: 10_000,
  earlySend: true,
};

export type FinalizeReason = "pause" | "ceiling" | "tap" | "early";

interface Utterance {
  readonly transcript: string;
  readonly touching: boolean;
  /** Parakeet called the current transcript a finished utterance. */
  readonly eou: boolean;
}

export type EndOfTurnState =
  | { readonly kind: "idle" }
  | { readonly kind: "muted" }
  | ({ readonly kind: "speaking" } & Utterance)
  | ({
      readonly kind: "paused";
      readonly since: number;
      readonly voice: PauseVoice;
    } & Utterance)
  | { readonly kind: "finalizing"; readonly reason: FinalizeReason };

export type EndOfTurnEvent =
  | { readonly type: "vad"; readonly speaking: boolean; readonly atMs: number }
  | { readonly type: "partial"; readonly text: string; readonly atMs: number }
  | { readonly type: "eou"; readonly text: string; readonly atMs: number }
  | { readonly type: "tick"; readonly atMs: number }
  | { readonly type: "tap"; readonly atMs: number }
  | { readonly type: "holdStart"; readonly atMs: number }
  | { readonly type: "holdEnd"; readonly atMs: number }
  | { readonly type: "muted"; readonly muted: boolean; readonly atMs: number };

export type EndOfTurnEffect = { readonly type: "finalize"; readonly reason: FinalizeReason };

export interface EndOfTurnStep {
  readonly state: EndOfTurnState;
  readonly effects: ReadonlyArray<EndOfTurnEffect>;
}

/**
 * A voice heard in the pause before its words are known. Parakeet decodes in 320 ms chunks, so the
 * words for a voice arrive up to `WORDS_LAG_MS` after it ends; a voice without words is noise.
 */
type PauseVoice =
  | { readonly kind: "quiet" }
  | { readonly kind: "voiced" }
  | { readonly kind: "ended"; readonly atMs: number };

const WORDS_LAG_MS = 400;

export const INITIAL_END_OF_TURN_STATE: EndOfTurnState = { kind: "idle" };

const TRAILING_FILLER = /\b(?:and|so|um+|uh+|but|because)[\s,.…-]*$/i;
const TRAILING_HOLD = /\b(?:hang|hold) on[\s,.…!-]*$/i;

const NEW_UTTERANCE: Utterance = { transcript: "", touching: false, eou: false };

export function stepEndOfTurn(
  state: EndOfTurnState,
  event: EndOfTurnEvent,
  config: EndOfTurnConfig = DEFAULT_END_OF_TURN_CONFIG,
): EndOfTurnStep {
  if (event.type === "muted") {
    return stay(
      event.muted ? { kind: "muted" } : state.kind === "muted" ? { kind: "idle" } : state,
    );
  }
  switch (state.kind) {
    case "muted":
      return stay(state);
    case "idle":
    case "finalizing":
      if (event.type === "vad" && event.speaking) {
        return stay({ kind: "speaking", ...NEW_UTTERANCE });
      }
      if (state.kind === "idle" && (event.type === "partial" || event.type === "eou")) {
        return stay({ kind: "speaking", ...heard(NEW_UTTERANCE, event) });
      }
      return stay(state);
    case "speaking":
      switch (event.type) {
        case "vad":
          return event.speaking
            ? stay(state)
            : decide(
                { ...state, kind: "paused", since: event.atMs, voice: { kind: "quiet" } },
                event.atMs,
                config,
              );
        case "partial":
        case "eou":
          return stay({ ...state, ...heard(state, event) });
        case "tap":
          return finalize(state, "tap");
        case "holdStart":
        case "holdEnd":
          return stay({ ...state, touching: event.type === "holdStart" });
        case "tick":
          return stay(state);
      }
    case "paused":
      switch (event.type) {
        case "vad":
          if (event.speaking) return stay({ ...state, voice: { kind: "voiced" } });
          return state.voice.kind === "voiced"
            ? decide({ ...state, voice: { kind: "ended", atMs: event.atMs } }, event.atMs, config)
            : stay(state);
        case "partial":
        case "eou": {
          const utterance = heard(state, event);
          if (utterance.transcript === state.transcript || state.voice.kind === "quiet") {
            return decide({ ...state, ...utterance }, event.atMs, config);
          }
          if (state.voice.kind === "voiced") {
            return stay({
              kind: "speaking",
              transcript: utterance.transcript,
              touching: state.touching,
              eou: utterance.eou,
            });
          }
          return decide(
            { ...state, ...utterance, since: state.voice.atMs, voice: { kind: "quiet" } },
            event.atMs,
            config,
          );
        }
        case "tap":
          return finalize(state, "tap");
        case "holdStart":
          return stay({ ...state, touching: true });
        case "holdEnd":
          return decide({ ...state, touching: false, since: event.atMs }, event.atMs, config);
        case "tick":
          return decide(state, event.atMs, config);
      }
  }
}

function heard(utterance: Utterance, event: { type: "partial" | "eou"; text: string }): Utterance {
  const transcript = event.text.trim() === "" ? utterance.transcript : event.text;
  return {
    ...utterance,
    transcript,
    eou: event.type === "eou" || (utterance.eou && transcript === utterance.transcript),
  };
}

function isHeld(state: Utterance): boolean {
  return state.touching || TRAILING_HOLD.test(state.transcript);
}

function decide(
  state: Extract<EndOfTurnState, { kind: "paused" }>,
  atMs: number,
  config: EndOfTurnConfig,
): EndOfTurnStep {
  const silentMs = atMs - state.since;
  const wordsMayFollow =
    state.voice.kind === "voiced" ||
    (state.voice.kind === "ended" && atMs - state.voice.atMs < WORDS_LAG_MS);
  if (isHeld(state) || wordsMayFollow) {
    return silentMs >= config.ceilingMs ? finalize(state, "ceiling") : stay(state);
  }
  if (
    config.earlySend &&
    state.eou &&
    silentMs >= config.floorMs &&
    !TRAILING_FILLER.test(state.transcript)
  ) {
    return finalize(state, "early");
  }
  return silentMs >= config.pauseMs ? finalize(state, "pause") : stay(state);
}

function finalize(state: Utterance, reason: FinalizeReason): EndOfTurnStep {
  if (state.transcript.trim() === "") return stay({ kind: "idle" });
  return { state: { kind: "finalizing", reason }, effects: [{ type: "finalize", reason }] };
}

function stay(state: EndOfTurnState): EndOfTurnStep {
  return { state, effects: [] };
}
