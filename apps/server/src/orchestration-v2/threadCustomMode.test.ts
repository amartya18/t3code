import { ProviderThreadId, type ThreadCustomMode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { customModeTurnForRun, nextThreadCustomMode } from "./threadCustomMode.ts";

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

  it("activates, reminds, stops once, and activates again across on, off, on", () => {
    let customMode: ThreadCustomMode | undefined;
    const runs: Array<ReturnType<typeof run>> = [];
    const kinds: Array<string> = [];
    const set = (skill: "review" | null, time: string) => {
      customMode = nextThreadCustomMode(customMode, skill, at(time)) ?? customMode;
    };
    const turn = (time: string) => {
      const current = run(runs.length + 1, null);
      kinds.push(customModeTurnForRun({ customMode, run: current, runs }).kind);
      runs.push({ ...current, startedAt: at(time) });
    };
    set("review", "10:00:00");
    turn("10:01:00");
    turn("10:02:00");
    set(null, "10:03:00");
    turn("10:04:00");
    turn("10:05:00");
    set("review", "10:06:00");
    turn("10:07:00");
    expect(kinds).toEqual(["activate", "remind", "exit", "none", "activate"]);
  });
});
