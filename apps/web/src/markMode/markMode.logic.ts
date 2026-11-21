import type { SpeechWord } from "@t3tools/contracts";

export type MarkModePhase = "idle" | "starting" | "recording" | "transcribing";
export type MarkModeEvent = "start" | "recording" | "finished" | "cancelled" | "failed" | "done";

const TRANSITIONS: Record<MarkModePhase, Partial<Record<MarkModeEvent, MarkModePhase>>> = {
  idle: { start: "starting" },
  // The overlay can finish before the microphone opens; the session then transcribes what it has.
  starting: { recording: "recording", finished: "transcribing", cancelled: "idle", failed: "idle" },
  recording: { finished: "transcribing", cancelled: "idle", failed: "idle" },
  transcribing: { done: "idle" },
};

/** The next phase, or null when the event does not apply in this phase. */
export function nextMarkModePhase(
  phase: MarkModePhase,
  event: MarkModeEvent,
): MarkModePhase | null {
  return TRANSITIONS[phase][event] ?? null;
}

type MarkTiming = { readonly index: number; readonly startedAt: number };

/**
 * The transcript with `[n]` at the word boundary nearest each mark's start. Boundary i is the
 * gap before word i (the last one follows the final word); a mark inside a gap is at distance 0.
 */
export function buildMarkModeText(input: {
  readonly text: string;
  readonly words: ReadonlyArray<SpeechWord> | undefined;
  readonly marks: ReadonlyArray<MarkTiming>;
  readonly audioStartedAt: number;
}): string {
  const words = (input.words ?? [])
    .map((word) => ({ ...word, text: word.text.trim() }))
    .filter((word) => word.text.length > 0);
  const sorted = input.marks.toSorted((a, b) => a.index - b.index);
  const label = (marks: ReadonlyArray<MarkTiming>) => marks.map(({ index }) => `[${index}]`);
  const text = input.text.trim();
  if (words.length === 0) {
    // Without word timings the markers cannot be placed, so they follow the text.
    return [text, ...label(sorted)].filter(Boolean).join(" ");
  }

  const byBoundary = new Map<number, MarkTiming[]>();
  for (const mark of sorted) {
    const offset = mark.startedAt - input.audioStartedAt;
    let best = 0;
    let bestDistance = Infinity;
    for (let boundary = 0; boundary <= words.length; boundary++) {
      const from = boundary === 0 ? 0 : words[boundary - 1]!.endMs;
      const to = boundary === words.length ? Infinity : words[boundary]!.startMs;
      const distance = Math.max(from - offset, offset - to, 0);
      if (distance < bestDistance) {
        best = boundary;
        bestDistance = distance;
      }
    }
    byBoundary.set(best, [...(byBoundary.get(best) ?? []), mark]);
  }

  const tokens: string[] = [];
  for (let boundary = 0; boundary <= words.length; boundary++) {
    tokens.push(...label(byBoundary.get(boundary) ?? []));
    const word = words[boundary];
    if (word) tokens.push(word.text);
  }
  return tokens.join(" ");
}
