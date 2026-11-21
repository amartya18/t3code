import type { MarkModeStroke } from "@t3tools/contracts";

/** Strokes drawn on one display without a pause long enough to end the mark. */
export interface MarkGroup {
  readonly displayId: number;
  readonly strokes: readonly MarkModeStroke[];
}

/** `drawing` holds the pen down, so no deadline runs until the stroke lands. */
export type GroupingState =
  | { readonly phase: "idle" }
  | { readonly phase: "drawing"; readonly group: MarkGroup }
  | { readonly phase: "pausing"; readonly group: MarkGroup; readonly deadline: number };

/** `now` is the main process clock; stroke times are only carried as data. */
export type GroupingEvent =
  | { readonly type: "pen-down"; readonly displayId: number }
  | {
      readonly type: "stroke";
      readonly displayId: number;
      readonly stroke: MarkModeStroke;
      readonly now: number;
    }
  | { readonly type: "deadline"; readonly now: number }
  | { readonly type: "flush" };

export interface GroupingStep {
  readonly state: GroupingState;
  /** Marks that ended on this step, oldest first. */
  readonly closed: readonly MarkGroup[];
}

export const initialGroupingState: GroupingState = { phase: "idle" };

const IDLE: GroupingState = initialGroupingState;

const closing = (state: GroupingState): readonly MarkGroup[] =>
  state.phase !== "idle" && state.group.strokes.length > 0 ? [state.group] : [];

/** The open group continues only on the same display; any other display starts a new one. */
const continuing = (state: GroupingState, displayId: number) =>
  state.phase !== "idle" && state.group.displayId === displayId
    ? { group: state.group, closed: [] }
    : { group: { displayId, strokes: [] }, closed: closing(state) };

export function stepGrouping(
  state: GroupingState,
  event: GroupingEvent,
  pauseMs: number,
): GroupingStep {
  switch (event.type) {
    case "pen-down": {
      const { group, closed } = continuing(state, event.displayId);
      return { state: { phase: "drawing", group }, closed };
    }
    case "stroke": {
      const { group, closed } = continuing(state, event.displayId);
      return {
        state: {
          phase: "pausing",
          group: { displayId: group.displayId, strokes: [...group.strokes, event.stroke] },
          deadline: event.now + pauseMs,
        },
        closed,
      };
    }
    case "deadline":
      return state.phase === "pausing" && event.now >= state.deadline
        ? { state: IDLE, closed: [state.group] }
        : { state, closed: [] };
    case "flush":
      return { state: IDLE, closed: closing(state) };
  }
}
