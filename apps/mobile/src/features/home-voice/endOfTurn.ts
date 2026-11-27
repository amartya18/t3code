/** Smart Turn's score at or above which a pause ends the user's turn at once. */
export const TURN_DONE_PROBABILITY = 0.7;
/** An unfinished pause is scored again this often, over the silence heard since. */
export const RESCORE_MS = 500;
/** Audio kept from before the detector's speech start, so the user's first word is whole. */
export const PRE_ROLL_MS = 400;

export interface TurnConfig {
  /** The detector reports a start this long after speech starts, and an end this long after it ends. */
  readonly vad: { readonly minSpeechMs: number; readonly minSilenceMs: number };
  /** How long a pause Smart Turn calls unfinished waits for more speech before the turn ends anyway. */
  readonly unfinishedWaitMs: number;
}

/** What Parakeet heard in one piece of a turn. */
export interface Heard {
  readonly text: string;
  /** A fresh id; a turn is sent under its last piece's. */
  readonly messageId: string;
}

/** A stretch of the turn's audio, from `fromMs` to the next piece's start or the turn's end. */
interface Piece {
  readonly fromMs: number;
  readonly heard: Heard | null;
}

/** Engine times, which go back to `turnScore` and `transcribe` as they came. */
interface Speech {
  readonly startMs: number;
  /** Where the next piece starts: the pre-roll before the user's first word, then each cut. */
  readonly cutMs: number;
  readonly pieces: ReadonlyArray<Piece>;
}

type LiveTurn =
  | { readonly kind: "idle" }
  | { readonly kind: "muted" }
  | ({ readonly kind: "speaking" } & Speech)
  | ({
      readonly kind: "paused";
      readonly endMs: number;
      /** When JS heard the user's speech end; the wait and its scores count from here. */
      readonly endedAtMs: number;
      /** Smart Turn's latest score, null until it first answers. */
      readonly probability: number | null;
      readonly scoresAsked: number;
      /** The end of the audio Smart Turn is scoring now, which its answer must match. */
      readonly scoringToMs: number | null;
    } & Speech);

type Paused = Extract<LiveTurn, { kind: "paused" }>;

interface DecidedTurn {
  readonly turn: number;
  readonly pieces: ReadonlyArray<Piece>;
}

export interface TurnState {
  readonly live: LiveTurn;
  readonly decided: ReadonlyArray<DecidedTurn>;
  readonly count: number;
}

export type TurnEvent =
  | {
      readonly type: "vad";
      readonly speaking: boolean;
      /** Engine time the user's speech really started or ended. */
      readonly speechMs: number;
      readonly atMs: number;
    }
  | {
      readonly type: "scored";
      readonly toMs: number;
      readonly probability: number;
      readonly atMs: number;
    }
  | {
      readonly type: "transcribed";
      readonly fromMs: number;
      readonly text: string;
      readonly messageId: string;
      readonly atMs: number;
    }
  | { readonly type: "tick"; readonly atMs: number }
  | { readonly type: "muted"; readonly muted: boolean; readonly atMs: number };

export type TurnEffect =
  | { readonly type: "scoreTurn"; readonly fromMs: number; readonly toMs: number }
  | { readonly type: "transcribe"; readonly fromMs: number; readonly toMs: number }
  | {
      readonly type: "score";
      readonly turn: number;
      readonly probability: number;
      /** Null for a score that came after he spoke again or the turn ended. */
      readonly silenceMs: number | null;
      readonly decision: "send" | "wait" | "ignore";
    }
  | {
      readonly type: "decided";
      readonly turn: number;
      readonly endedAtMs: number;
      readonly probability: number | null;
      readonly waited: boolean;
    }
  /** Every piece of the turn is transcribed; `text` is empty when no words came of it. */
  | {
      readonly type: "heard";
      readonly turn: number;
      readonly text: string;
      readonly messageId: string;
    };

export interface TurnStep {
  readonly state: TurnState;
  readonly effects: ReadonlyArray<TurnEffect>;
}

const IDLE: LiveTurn = { kind: "idle" };
const MUTED: LiveTurn = { kind: "muted" };

export const INITIAL_TURN_STATE: TurnState = { live: IDLE, decided: [], count: 0 };

/**
 * Done ends the turn; unfinished transcribes the piece so far, then rescores every RESCORE_MS
 * until a score is done or the wait runs out.
 */
export function stepTurn(state: TurnState, event: TurnEvent, config: TurnConfig): TurnStep {
  switch (event.type) {
    case "muted":
      if (event.muted) return stay({ ...state, live: MUTED });
      return state.live.kind === "muted" ? stay({ ...state, live: IDLE }) : stay(state);
    case "vad":
      return onVad(state, event);
    case "scored":
      return onScored(state, event, config);
    case "transcribed":
      return onTranscribed(state, event);
    case "tick":
      return onTick(state, event.atMs, config);
  }
}

export function isTurnOpen(state: TurnState): boolean {
  return state.live.kind === "speaking" || state.live.kind === "paused" || state.decided.length > 0;
}

/** Drops the turn in progress; ended turns still finish. */
export function dropLiveTurn(state: TurnState): TurnState {
  return state.live.kind === "speaking" || state.live.kind === "paused"
    ? { ...state, live: IDLE }
    : state;
}

function onVad(state: TurnState, event: Extract<TurnEvent, { type: "vad" }>): TurnStep {
  const { live } = state;
  if (event.speaking) {
    if (live.kind === "idle") {
      const speech = { startMs: event.speechMs, cutMs: event.speechMs - PRE_ROLL_MS, pieces: [] };
      return stay({ ...state, live: { kind: "speaking", ...speech } });
    }
    if (live.kind !== "paused") return stay(state);
    const { startMs, cutMs, pieces } = live;
    return stay({ ...state, live: { kind: "speaking", startMs, cutMs, pieces } });
  }
  if (live.kind !== "speaking") return stay(state);
  return score(state, {
    ...live,
    kind: "paused",
    endMs: event.speechMs,
    endedAtMs: event.atMs,
    probability: null,
    scoresAsked: 0,
    scoringToMs: null,
  });
}

/**
 * Speech that resumes in the wait reaches JS only after the detector's onset hold, so the
 * deadline runs that much past the wait: speech he started inside the wait still continues it.
 */
function onTick(state: TurnState, atMs: number, config: TurnConfig): TurnStep {
  const { live } = state;
  if (live.kind !== "paused") return stay(state);
  const waitedMs = atMs - live.endedAtMs;
  if (waitedMs >= config.unfinishedWaitMs + config.vad.minSpeechMs)
    return decide(state, live, true);
  if (live.scoringToMs !== null || waitedMs < live.scoresAsked * RESCORE_MS) return stay(state);
  return score(state, live, waitedMs);
}

/** Scores the turn through the silence heard so far; the first score ends at the speech end. */
function score(state: TurnState, live: Paused, waitedMs = 0): TurnStep {
  const toMs = live.endMs + waitedMs;
  return {
    state: { ...state, live: { ...live, scoresAsked: live.scoresAsked + 1, scoringToMs: toMs } },
    effects: [{ type: "scoreTurn", fromMs: live.startMs, toMs }],
  };
}

function onScored(
  state: TurnState,
  event: Extract<TurnEvent, { type: "scored" }>,
  config: TurnConfig,
): TurnStep {
  const { live } = state;
  const { probability } = event;
  if (live.kind !== "paused" || live.scoringToMs !== event.toMs) {
    const turn = live.kind === "speaking" || live.kind === "paused" ? state.count + 1 : state.count;
    return {
      state,
      effects: [{ type: "score", turn, probability, silenceMs: null, decision: "ignore" }],
    };
  }
  const scored = { ...live, probability, scoringToMs: null };
  const done = probability >= TURN_DONE_PROBABILITY;
  const logged: TurnEffect = {
    type: "score",
    turn: state.count + 1,
    probability,
    silenceMs: event.atMs - live.endedAtMs + config.vad.minSilenceMs,
    decision: done ? "send" : "wait",
  };
  if (done) {
    const decided = decide(state, scored, false);
    return { ...decided, effects: [logged, ...decided.effects] };
  }
  if (live.cutMs >= live.endMs) return { state: { ...state, live: scored }, effects: [logged] };
  return {
    state: {
      ...state,
      live: {
        ...scored,
        cutMs: live.endMs,
        pieces: [...live.pieces, { fromMs: live.cutMs, heard: null }],
      },
    },
    effects: [logged, { type: "transcribe", fromMs: live.cutMs, toMs: live.endMs }],
  };
}

function decide(state: TurnState, live: Paused, waited: boolean): TurnStep {
  const rest = live.cutMs < live.endMs;
  const turn = state.count + 1;
  const pieces = rest ? [...live.pieces, { fromMs: live.cutMs, heard: null }] : live.pieces;
  const settled = settle({
    live: IDLE,
    decided: [...state.decided, { turn, pieces }],
    count: turn,
  });
  return {
    state: settled.state,
    effects: [
      {
        type: "decided",
        turn,
        endedAtMs: live.endedAtMs,
        probability: live.probability,
        waited,
      },
      ...(rest ? [{ type: "transcribe", fromMs: live.cutMs, toMs: live.endMs } as const] : []),
      ...settled.effects,
    ],
  };
}

function onTranscribed(
  state: TurnState,
  event: Extract<TurnEvent, { type: "transcribed" }>,
): TurnStep {
  const heard = { text: event.text, messageId: event.messageId };
  const fill = (pieces: ReadonlyArray<Piece>) =>
    pieces.some((piece) => piece.fromMs === event.fromMs && piece.heard === null)
      ? pieces.map((piece) => (piece.fromMs === event.fromMs ? { ...piece, heard } : piece))
      : pieces;
  const { live } = state;
  if ((live.kind === "speaking" || live.kind === "paused") && fill(live.pieces) !== live.pieces) {
    return stay({ ...state, live: { ...live, pieces: fill(live.pieces) } });
  }
  const index = state.decided.findIndex((turn) => fill(turn.pieces) !== turn.pieces);
  if (index === -1) return stay(state);
  const decided = state.decided.map((turn, at) =>
    at === index ? { ...turn, pieces: fill(turn.pieces) } : turn,
  );
  return settle({ ...state, decided });
}

/** Hands on each ended turn, in order, once every piece of it is transcribed. */
function settle(state: TurnState): TurnStep {
  const effects: TurnEffect[] = [];
  let decided = state.decided;
  for (const turn of state.decided) {
    const heard = turn.pieces.flatMap((piece) => (piece.heard === null ? [] : [piece.heard]));
    const last = heard.at(-1);
    if (heard.length < turn.pieces.length || last === undefined) break;
    const text = heard
      .map((piece) => piece.text.trim())
      .filter((piece) => piece !== "")
      .join(" ");
    effects.push({ type: "heard", turn: turn.turn, text, messageId: last.messageId });
    decided = decided.slice(1);
  }
  return { state: decided === state.decided ? state : { ...state, decided }, effects };
}

function stay(state: TurnState): TurnStep {
  return { state, effects: [] };
}
