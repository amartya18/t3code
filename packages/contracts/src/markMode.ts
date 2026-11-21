/**
 * Fork-only: Mark Mode. The person talks while drawing on any screen; when they stop, the
 * active thread's composer gets the transcript with [n] markers and one image per mark.
 */
import * as Schema from "effect/Schema";

export const DEFAULT_MARK_MODE_PAUSE_MS = 1_500;
export const MarkModePauseMs = Schema.Int.check(
  Schema.isBetween({ minimum: 300, maximum: 10_000 }),
);
export type MarkModePauseMs = typeof MarkModePauseMs.Type;

/** One ink style keeps the overlay and the flattened images identical. */
export const MARK_MODE_INK = { color: "#FF3B30", width: 4 } as const;
export const MARK_MODE_IMAGE_MAX_EDGE = 1_500;

/** DIP coordinates relative to the top-left of the display the stroke was drawn on. */
export const MarkModePoint = Schema.Struct({ x: Schema.Number, y: Schema.Number });
export type MarkModePoint = typeof MarkModePoint.Type;

/**
 * Times are wall-clock epoch milliseconds, the clock the audio start shares. Not
 * `performance.timeOrigin`: each renderer's performance clock stops while the machine sleeps.
 */
export const MarkModeStroke = Schema.Struct({
  points: Schema.Array(MarkModePoint),
  startedAt: Schema.Number,
  endedAt: Schema.Number,
});
export type MarkModeStroke = typeof MarkModeStroke.Type;

export const MarkModeMark = Schema.Struct({
  /** 1-based, in the order marks began. */
  index: Schema.Int,
  /** Epoch milliseconds of the mark's first stroke. */
  startedAt: Schema.Number,
  /** DIP size of the display the mark was drawn on; strokes scale from it onto the screenshot. */
  display: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
  strokes: Schema.Array(MarkModeStroke),
  /** The display without ink, at most MARK_MODE_IMAGE_MAX_EDGE on its long edge. */
  screenshot: Schema.Struct({ dataUrl: Schema.String, width: Schema.Int, height: Schema.Int }),
});
export type MarkModeMark = typeof MarkModeMark.Type;

export const MarkModeStartFailure = Schema.Literals(["screen-permission", "unsupported", "busy"]);
export type MarkModeStartFailure = typeof MarkModeStartFailure.Type;

export const MarkModeStartResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: MarkModeStartFailure,
    message: Schema.String,
  }),
]);
export type MarkModeStartResult = typeof MarkModeStartResult.Type;

export const DesktopMarkModeEvent = Schema.Union([
  /** The global shortcut was pressed while idle; the renderer starts the session because it owns the microphone. */
  Schema.Struct({ type: Schema.Literal("start-requested") }),
  /** The overlay closed with Done, Enter, Escape or the shortcut. Every mark is captured. */
  Schema.Struct({ type: Schema.Literal("finished"), marks: Schema.Array(MarkModeMark) }),
  /** The person chose Discard. */
  Schema.Struct({ type: Schema.Literal("cancelled") }),
]);
export type DesktopMarkModeEvent = typeof DesktopMarkModeEvent.Type;

export interface DesktopMarkModeBridge {
  /** Opens the see-through overlay on every display. */
  readonly start: (input: { readonly pauseMs: MarkModePauseMs }) => Promise<MarkModeStartResult>;
  /** Closes the overlay; the marks arrive as a "finished" event. */
  readonly finish: () => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly onEvent: (listener: (event: DesktopMarkModeEvent) => void) => () => void;
}
