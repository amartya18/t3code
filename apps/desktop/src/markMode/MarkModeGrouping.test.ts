import { describe, expect, it } from "vite-plus/test";

import {
  initialGroupingState,
  stepGrouping,
  type GroupingEvent,
  type GroupingState,
  type MarkGroup,
} from "./MarkModeGrouping.ts";

const PAUSE = 1_500;
const stroke = (startedAt: number) => ({
  points: [{ x: startedAt, y: 0 }],
  startedAt,
  endedAt: startedAt + 100,
});

function run(events: readonly GroupingEvent[], state: GroupingState = initialGroupingState) {
  const closed: MarkGroup[] = [];
  for (const event of events) {
    const step = stepGrouping(state, event, PAUSE);
    state = step.state;
    closed.push(...step.closed);
  }
  return { state, closed };
}

const draw = (displayId: number, at: number): GroupingEvent[] => [
  { type: "pen-down", displayId },
  { type: "stroke", displayId, stroke: stroke(at), now: at + 100 },
];

describe("stepGrouping", () => {
  it("keeps strokes inside the pause in one mark and closes it once the pause elapses", () => {
    const strokes = [...draw(1, 0), ...draw(1, 1_000)];
    // The second stroke landed at 1_100, so the mark stays open until 2_600.
    expect(run([...strokes, { type: "deadline", now: 2_599 }]).closed).toEqual([]);

    const { state, closed } = run([...strokes, { type: "deadline", now: 2_600 }]);
    expect(closed).toEqual([{ displayId: 1, strokes: [stroke(0), stroke(1_000)] }]);
    expect(state).toEqual({ phase: "idle" });
  });

  it("holds the mark open while the pen is down, however long the stroke takes", () => {
    const { state, closed } = run([
      ...draw(1, 0),
      { type: "pen-down", displayId: 1 },
      { type: "deadline", now: 60_000 },
      { type: "stroke", displayId: 1, stroke: stroke(200), now: 60_000 },
    ]);
    expect(closed).toEqual([]);
    expect(state).toMatchObject({ phase: "pausing", deadline: 61_500 });
  });

  it("closes the open mark when drawing moves to another display", () => {
    const { state, closed } = run([...draw(1, 0), { type: "pen-down", displayId: 2 }]);
    expect(closed).toEqual([{ displayId: 1, strokes: [stroke(0)] }]);
    expect(state).toEqual({ phase: "drawing", group: { displayId: 2, strokes: [] } });
  });

  it("flush closes an open mark and ignores a pen-down with no stroke yet", () => {
    expect(run([...draw(1, 0), { type: "flush" }]).closed).toEqual([
      { displayId: 1, strokes: [stroke(0)] },
    ]);
    expect(run([{ type: "pen-down", displayId: 1 }, { type: "flush" }])).toEqual({
      state: { phase: "idle" },
      closed: [],
    });
  });
});
