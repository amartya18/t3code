import { describe, expect, it } from "vite-plus/test";

import { buildMarkModeText, nextMarkModePhase, type MarkModePhase } from "./markMode.logic";

const AUDIO_START = 1_000_000;
const words = [
  { text: "This", startMs: 0, endMs: 300 },
  { text: "button", startMs: 400, endMs: 800 },
  { text: "is", startMs: 900, endMs: 1_000 },
  { text: "wrong.", startMs: 1_100, endMs: 1_500 },
];
const mark = (index: number, offsetMs: number) => ({ index, startedAt: AUDIO_START + offsetMs });
const build = (
  marks: ReturnType<typeof mark>[],
  input = { text: "This button is wrong.", words },
) => buildMarkModeText({ ...input, marks, audioStartedAt: AUDIO_START });

describe("buildMarkModeText", () => {
  it.each([
    ["inside a gap", [mark(1, 350)], "This [1] button is wrong."],
    ["inside a word, nearer its start", [mark(1, 450)], "This [1] button is wrong."],
    ["inside a word, nearer its end", [mark(1, 750)], "This button [1] is wrong."],
    ["a tie, at the earlier boundary", [mark(1, 600)], "This [1] button is wrong."],
    ["before the audio started", [mark(1, -2_000)], "[1] This button is wrong."],
    ["after the last word", [mark(1, 9_000)], "This button is wrong. [1]"],
    [
      "several marks at one boundary, in index order",
      [mark(2, 360), mark(1, 320)],
      "This [1] [2] button is wrong.",
    ],
    [
      "marks at different boundaries",
      [mark(1, 50), mark(2, 1_050)],
      "[1] This button is [2] wrong.",
    ],
  ])("places a mark %s", (_case, marks, expected) => {
    expect(build(marks)).toBe(expected);
  });

  it("writes markers only for an empty transcript", () => {
    expect(build([mark(2, 0), mark(1, 0)], { text: " ", words: [] })).toBe("[1] [2]");
  });

  it("appends markers when the transcript has no word timings", () => {
    expect(build([mark(1, 350)], { text: "This button is wrong.", words: [] })).toBe(
      "This button is wrong. [1]",
    );
  });
});

describe("nextMarkModePhase", () => {
  const run = (events: Parameters<typeof nextMarkModePhase>[1][]) =>
    events.reduce<MarkModePhase>(
      (phase, event) => nextMarkModePhase(phase, event) ?? phase,
      "idle",
    );

  it("walks a session from start to delivery", () => {
    expect(run(["start", "recording", "finished", "done"])).toBe("idle");
    expect(run(["start", "recording", "finished"])).toBe("transcribing");
  });

  it("transcribes when the overlay finishes before the microphone opens", () => {
    expect(run(["start", "finished"])).toBe("transcribing");
    expect(nextMarkModePhase("transcribing", "recording")).toBeNull();
  });

  it("ignores a second start and a cancel once transcribing", () => {
    expect(nextMarkModePhase("recording", "start")).toBeNull();
    expect(nextMarkModePhase("transcribing", "cancelled")).toBeNull();
  });

  it("returns to idle on cancel or failure while capturing", () => {
    expect(run(["start", "failed"])).toBe("idle");
    expect(run(["start", "recording", "cancelled"])).toBe("idle");
  });
});
