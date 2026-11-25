import { describe, expect, it } from "vite-plus/test";

import {
  diffHomeUpdates,
  renderHomeUpdate,
  startHomeUpdateCursor,
  type HomeUpdateCursor,
} from "./homeUpdates";
import type { HomeMessage, HomeView, LaunchedThread } from "./homeView";

const START = Date.parse("2026-11-25T12:00:00.000Z");

const message = (
  role: HomeMessage["role"],
  text: string,
  minute: number,
  streaming = false,
): HomeMessage => ({ role, text, createdAtMs: START + minute * 60_000, streaming });

const launched = (
  id: string,
  state: LaunchedThread["state"],
  runId: string,
  finishedMinute: number | null = null,
): LaunchedThread => ({
  key: `env:home-launched:${id}`,
  title: `Fix ${id}`,
  runId,
  state,
  finishedAtMs: finishedMinute === null ? null : START + finishedMinute * 60_000,
  preview: "Merged and green.",
});

const atStart: HomeView = {
  homeActive: false,
  homeNeedsInput: false,
  messages: [message("user", "Earlier question", -10), message("assistant", "Earlier answer", -9)],
  threads: [
    launched("pairing", "needsInput", "run-1"),
    launched("ci", "failed", "run-1", -30),
    launched("docs", "finished", "run-1", -60),
    launched("sync", "running", "run-1"),
  ],
};

/** Runs each view through the session in order, as the app does, and collects what it sends. */
function play(views: ReadonlyArray<HomeView>, cursor: HomeUpdateCursor) {
  const sent: Array<string> = [];
  let current = cursor;
  for (const view of views) {
    const result = diffHomeUpdates(view, current);
    sent.push(...result.updates.map(renderHomeUpdate));
    current = result.cursor;
  }
  return { sent, cursor: current };
}

describe("diffHomeUpdates", () => {
  const cursor = startHomeUpdateCursor(atStart, START);

  it("reports nothing that was already true at the start", () => {
    expect(play([atStart], cursor).sent).toEqual([]);
  });

  it("sends Home's reply to a relay once its run ends, without links or hashes", () => {
    const asked = [...atStart.messages!, message("user", "Amar (voice): did PR 43 merge?", 1)];
    const working = { ...atStart, homeActive: true, messages: asked };
    const streaming = {
      ...atStart,
      messages: [
        ...asked,
        message("assistant", "Checking", 2),
        message("assistant", "Yes", 3, true),
      ],
    };
    const done = {
      ...atStart,
      messages: [
        ...asked,
        message("assistant", "Checking", 2),
        message("assistant", "Yes, [PR 43](https://github.com/x/pull/43) merged as 80a2c4f334.", 3),
      ],
    };
    expect(play([working, streaming, done, done], cursor).sent).toEqual([
      "[Home update] Home replied: Yes, PR 43 merged as.",
    ]);
  });

  it("reports a launched thread that turns failed, needs input or finishes, once per run", () => {
    const failed = {
      ...atStart,
      threads: [
        ...atStart.threads.slice(0, 3),
        launched("sync", "failed", "run-1", 5),
        launched("new", "needsInput", "run-1"),
      ],
    };
    const rerun = {
      ...failed,
      threads: [
        ...atStart.threads.slice(0, 2),
        launched("docs", "finished", "run-2", 7),
        launched("sync", "failed", "run-1", 5),
        launched("new", "finished", "run-1", 8),
      ],
    };
    expect(play([failed, failed, rerun], cursor).sent).toEqual([
      '[Home update] "Fix sync" failed.',
      '[Home update] "Fix new" needs you.',
      '[Home update] "Fix docs" finished: Merged and green.',
      '[Home update] "Fix new" finished: Merged and green.',
    ]);
  });

  it("sends each update exactly once across a reconnect replay", () => {
    const answered = {
      ...atStart,
      messages: [...atStart.messages!, message("assistant", "All quiet.", 4)],
      threads: [...atStart.threads.slice(0, 3), launched("sync", "failed", "run-1", 5)],
    };
    const before = play([answered], cursor);
    expect(before.sent).toHaveLength(2);
    // Reconnecting drops Home's detail and the shells, then streams them back unchanged.
    const reset: HomeView = { ...atStart, messages: null, threads: [] };
    const stale = { ...atStart, homeActive: true };
    expect(play([reset, stale, answered, answered], before.cursor).sent).toEqual([]);
  });

  it("ignores a run that ended before the session but loaded after it", () => {
    const lateLoad = { ...atStart, threads: [launched("old", "finished", "run-9", -120)] };
    expect(play([lateLoad], cursor).sent).toEqual([]);
  });
});
