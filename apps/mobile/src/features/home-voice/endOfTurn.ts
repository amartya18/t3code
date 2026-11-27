/** Smart Turn's score at or above which a pause ends Amar's turn at once. */
export const TURN_DONE_PROBABILITY = 0.5;
/** How long a pause Smart Turn calls unfinished waits for more speech before the turn ends anyway. */
export const UNFINISHED_WAIT_MS = 2_000;
/** Audio kept from before the detector's speech start, so his first word is whole. */
export const PRE_ROLL_MS = 400;

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
  /** Where the next piece starts: the pre-roll before his first word, then each cut. */
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
      /** When JS heard his speech end; the wait counts from here. */
      readonly endedAtMs: number;
      /** Smart Turn's score, null until it answers; a pause still open scored below done. */
      readonly probability: number | null;
    } & Speech);

interface DecidedTurn {
  readonly turn: number;
  readonly pieces: ReadonlyArray<Piece>;
}

export interface TurnState {
  readonly live: LiveTurn;
  /** Ended turns, oldest first, until all their pieces are transcribed. */
  readonly decided: ReadonlyArray<DecidedTurn>;
  /** Turns decided this session. */
  readonly count: number;
}

export type TurnEvent =
  | {
      readonly type: "vad";
      readonly speaking: boolean;
      /** Engine time his speech really started or ended. */
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
 * Silero starts a turn; at each end of speech Smart Turn judges it. Done ends the turn; unfinished
 * transcribes the piece so far and waits for more speech, ending the turn anyway after the wait.
 */
export function stepTurn(state: TurnState, event: TurnEvent): TurnStep {
  switch (event.type) {
    case "muted":
      if (event.muted) return stay({ ...state, live: MUTED });
      return state.live.kind === "muted" ? stay({ ...state, live: IDLE }) : stay(state);
    case "vad":
      return onVad(state, event);
    case "scored":
      return onScored(state, event);
    case "transcribed":
      return onTranscribed(state, event);
    case "tick":
      return state.live.kind === "paused" && event.atMs - state.live.endedAtMs >= UNFINISHED_WAIT_MS
        ? decide(state, state.live, true)
        : stay(state);
  }
}

/** Amar's turn is on, or ended without its words known yet. */
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
  return {
    state: {
      ...state,
      live: {
        ...live,
        kind: "paused",
        endMs: event.speechMs,
        endedAtMs: event.atMs,
        probability: null,
      },
    },
    effects: [{ type: "scoreTurn", fromMs: live.startMs, toMs: event.speechMs }],
  };
}

function onScored(state: TurnState, event: Extract<TurnEvent, { type: "scored" }>): TurnStep {
  const { live } = state;
  if (live.kind !== "paused" || live.probability !== null || live.endMs !== event.toMs) {
    return stay(state);
  }
  const scored = { ...live, probability: event.probability };
  if (event.probability >= TURN_DONE_PROBABILITY) return decide(state, scored, false);
  return {
    state: {
      ...state,
      live: {
        ...scored,
        cutMs: live.endMs,
        pieces: [...live.pieces, { fromMs: live.cutMs, heard: null }],
      },
    },
    effects: [{ type: "transcribe", fromMs: live.cutMs, toMs: live.endMs }],
  };
}

function decide(
  state: TurnState,
  live: Extract<LiveTurn, { kind: "paused" }>,
  waited: boolean,
): TurnStep {
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
