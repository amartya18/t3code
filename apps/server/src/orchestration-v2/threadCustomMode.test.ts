import { ProviderThreadId, type ThreadCustomMode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type CustomModeTurn,
  customModeTurnForRun,
  nextThreadCustomMode,
  renderCustomModeTurn,
} from "./threadCustomMode.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-01-01T${time}Z`);
const conversation = ProviderThreadId.make("provider-thread:claude");
const otherConversation = ProviderThreadId.make("provider-thread:codex");
const run = (ordinal: number, startedAt: string | null, providerThreadId = conversation) => ({
  ordinal,
  startedAt: startedAt === null ? null : at(startedAt),
  providerThreadId,
});
const mode = (status: "on" | "off", time: string): ThreadCustomMode => ({
  status,
  skill: "review",
  updatedAt: DateTime.formatIso(at(time)),
});

describe("customModeTurnForRun", () => {
  it.each([
    ["no mode", undefined, [], run(1, null), "none"],
    ["on before the first turn", mode("on", "10:00:00"), [], run(1, null), "activate"],
    [
      "on after the previous turn started",
      mode("on", "10:05:00"),
      [run(1, "10:00:00")],
      run(2, null),
      "activate",
    ],
    [
      "on before the previous turn started, even one queued before the change",
      mode("on", "10:05:00"),
      [run(1, "10:06:00")],
      run(2, null),
      "remind",
    ],
    [
      "an earlier turn that never started",
      mode("on", "10:05:00"),
      [run(1, "10:00:00"), run(2, null)],
      run(3, null),
      "activate",
    ],
    [
      "a turn in another provider conversation",
      mode("on", "09:00:00"),
      [run(1, "10:00:00", otherConversation)],
      run(2, null),
      "activate",
    ],
    [
      "a fresh context",
      mode("on", "09:00:00"),
      [run(1, "10:00:00")],
      { ...run(2, null), freshContext: true },
      "activate",
    ],
    [
      "a retry, whose own earlier attempt started",
      mode("on", "10:05:00"),
      [run(1, "10:00:00"), run(2, "10:06:00")],
      run(2, "10:06:00"),
      "activate",
    ],
    [
      "off after the previous turn started",
      mode("off", "10:05:00"),
      [run(1, "10:00:00")],
      run(2, null),
      "exit",
    ],
    [
      "off before the previous turn started",
      mode("off", "09:00:00"),
      [run(1, "10:00:00")],
      run(2, null),
      "none",
    ],
  ] as const)("%s", (_name, customMode, runs, current, kind) => {
    expect(customModeTurnForRun({ customMode, run: current, runs }).kind).toBe(kind);
  });

  const replay = (
    steps: ReadonlyArray<readonly [string | null, string] | readonly ["turn", string]>,
  ) => {
    let customMode: ThreadCustomMode | undefined;
    const runs: Array<ReturnType<typeof run>> = [];
    const turns: Array<CustomModeTurn> = [];
    for (const [action, time] of steps) {
      if (action === "turn") {
        const current = run(runs.length + 1, null);
        turns.push(customModeTurnForRun({ customMode, run: current, runs }));
        runs.push({ ...current, startedAt: at(time) });
      } else {
        customMode = nextThreadCustomMode(customMode, action, at(time)) ?? customMode;
      }
    }
    return turns;
  };

  it("activates, reminds, stops once, and activates again across on, off, on", () => {
    const turns = replay([
      ["review", "10:00:00"],
      ["turn", "10:01:00"],
      ["turn", "10:02:00"],
      [null, "10:03:00"],
      ["turn", "10:04:00"],
      ["turn", "10:05:00"],
      ["review", "10:06:00"],
      ["turn", "10:07:00"],
    ]);
    expect(turns.map((turn) => turn.kind)).toEqual([
      "activate",
      "remind",
      "exit",
      "none",
      "activate",
    ]);
    expect(turns[4]).toEqual({ kind: "activate", skill: "review", replaces: undefined });
  });

  it.each([
    [
      "switched straight from one skill to another",
      [
        ["review", "10:00:00"],
        ["turn", "10:01:00"],
        ["poteto", "10:02:00"],
      ],
    ],
    [
      "turned off, then another skill on, before the next turn",
      [
        ["review", "10:00:00"],
        ["turn", "10:01:00"],
        [null, "10:02:00"],
        ["poteto", "10:03:00"],
      ],
    ],
  ] as const)("names the replaced skill when %s", (_name, steps) => {
    const turns = replay([
      ...steps,
      ["turn", "10:10:00"],
      ["turn", "10:11:00"],
      [null, "10:12:00"],
      ["turn", "10:13:00"],
    ]);
    expect(turns.map(renderCustomModeTurn)).toEqual([
      renderCustomModeTurn({ kind: "activate", skill: "review" }),
      {
        context:
          "Custom mode `review` is off and `poteto` is on for this thread. Stop following `review`'s skill. Follow `poteto` for this and every later message until it is turned off. This replaces any custom mode turned on earlier in this thread.",
        prefix: "$poteto ",
      },
      renderCustomModeTurn({ kind: "remind", skill: "poteto" }),
      renderCustomModeTurn({ kind: "exit", skill: "poteto" }),
    ]);
  });
});
