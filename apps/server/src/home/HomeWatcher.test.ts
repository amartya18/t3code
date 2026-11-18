import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type HomeSettings,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { diffWatchedThreads, type WatchedThreadState, withLatestReplies } from "./HomeWatcher.ts";

const hub = EnvironmentId.make("hub");

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: null },
    status: "running",
    latestRunId: "run-1",
    latestRunCompletedAt: null,
    pendingRuntimeRequest: null,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    createdAt: DateTime.makeUnsafe(0),
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const watching = (...ids: Array<string>): HomeSettings => ({
  threadId: ThreadId.make("home:current"),
  watchAll: false,
  watches: ids.map((id) => ({
    environmentId: hub,
    threadId: ThreadId.make(id),
    reason: "launched",
  })),
});

const run = (
  previous: ReadonlyMap<ThreadId, WatchedThreadState>,
  changed: Array<OrchestrationV2ThreadShell | [string, null]>,
  home: HomeSettings,
  knownWatchKeys: ReadonlySet<string> = new Set(home.watches.map((watch) => watch.threadId)),
) =>
  diffWatchedThreads({
    environmentId: hub,
    environmentLabel: "laptop13",
    previous,
    changed: changed.map((entry) =>
      Array.isArray(entry)
        ? { threadId: ThreadId.make(entry[0]), shell: null }
        : { threadId: entry.id, shell: entry },
    ),
    home,
    knownWatchKeys: knownWatchKeys as ReadonlySet<ThreadId>,
    startedAtMs: 1_000,
  });

const asking = (id: string, kind: "user_input" | "command") =>
  shell(id, {
    pendingRuntimeRequest: { id: `request-${kind}`, kind, createdAt: DateTime.makeUnsafe(0) },
  } as Partial<OrchestrationV2ThreadShell>);

describe("diffWatchedThreads", () => {
  it.effect("sets a baseline first, then reports a question and a completion", () =>
    Effect.gen(function* () {
      const home = watching("a");
      // The latest run's messages, as the projection's record read returns them.
      const threads = {
        getThreadRecords: (
          _threadId: ThreadId,
          _fields: unknown,
          filter?: { messageRunIds?: ReadonlyArray<string> },
        ) =>
          Effect.succeed({
            messages: filter?.messageRunIds?.includes("run-1")
              ? [{ role: "assistant", text: `Done.\n\nAll   tests pass. ${"x".repeat(400)}` }]
              : [],
          }),
      } as unknown as Parameters<typeof withLatestReplies>[0];
      const first = run(new Map(), [shell("a")], home);
      expect(first.events).toEqual([]);

      const askedShell = asking("a", "user_input");
      const asked = run(first.next, [askedShell], home);
      expect(asked.events).toMatchObject([
        { threadId: "a", kind: "question", environmentLabel: "laptop13" },
      ]);
      const askedReport = yield* withLatestReplies(threads, asked.events, [{ shell: askedShell }]);
      expect(askedReport[0]?.detail).toBeUndefined();

      const doneShell = shell("a", {
        status: "completed",
        latestRunCompletedAt: DateTime.makeUnsafe(1_000),
      });
      const done = run(asked.next, [doneShell], home);
      expect(done.events).toMatchObject([{ threadId: "a", kind: "completed" }]);
      const [reported] = yield* withLatestReplies(threads, done.events, [{ shell: doneShell }]);
      const detail = reported?.detail ?? "";
      expect(detail.startsWith("Done. All tests pass. xxx")).toBe(true);
      expect([detail.length, detail.endsWith("…")]).toEqual([300, true]);
      expect(
        run(
          done.next,
          [shell("a", { status: "completed", latestRunCompletedAt: DateTime.makeUnsafe(1_000) })],
          home,
        ).events,
      ).toEqual([]);
    }),
  );

  it("ignores unwatched threads and every Home thread, even when watching all", () => {
    const changed = [shell("a"), shell("home:old")];
    expect(run(new Map(), changed, watching()).next.size).toBe(0);

    const all = { ...watching(), watchAll: true };
    const baseline = run(new Map(), changed, all);
    const asked = run(baseline.next, [asking("a", "command"), asking("home:old", "command")], all);
    expect(asked.events).toMatchObject([{ threadId: "a", kind: "approval" }]);
  });

  it("ends a watch once when the thread is settled", () => {
    const home = watching("a");
    const first = run(new Map(), [shell("a")], home);
    const settled = run(first.next, [shell("a", { settledOverride: "settled" })], home);
    expect(settled.events).toMatchObject([{ threadId: "a", kind: "ended" }]);
    expect(run(settled.next, [shell("a", { settledOverride: "settled" })], home).events).toEqual(
      [],
    );
  });

  it("reports the first state of a thread Home launched after it started", () => {
    const launched = run(new Map(), [asking("a", "command")], watching("a"), new Set());
    expect(launched.events).toMatchObject([{ threadId: "a", kind: "approval" }]);
    expect(run(new Map(), [asking("a", "command")], watching("a")).events).toEqual([]);
  });

  it("ends a start-up watch on a thread settled or deleted while the server was down", () => {
    const home = watching("a", "b");
    const first = run(new Map(), [shell("a", { settledOverride: "settled" })], home);
    expect(first.events).toMatchObject([{ threadId: "a", kind: "ended" }]);
    expect(run(new Map(), [["b", null]], home).events).toMatchObject([
      { threadId: "b", kind: "ended" },
    ]);
    // A launch watch saved after start-up can arrive before its thread exists.
    expect(run(new Map(), [["b", null]], home, new Set()).events).toEqual([]);
  });

  it("reports the first state of a thread created after start-up, even when watching all", () => {
    const all = { ...watching(), watchAll: true };
    const created = asking("a", "user_input");
    const fresh = {
      ...created,
      createdAt: DateTime.makeUnsafe(2_000),
    } as OrchestrationV2ThreadShell;
    const old = { ...created, createdAt: DateTime.makeUnsafe(500) } as OrchestrationV2ThreadShell;
    expect(run(new Map(), [fresh], all).events).toMatchObject([
      { threadId: "a", kind: "question" },
    ]);
    expect(run(new Map(), [old], all).events).toEqual([]);
  });

  it("reports a failed run once per run", () => {
    const home = watching("a");
    const first = run(new Map(), [shell("a")], home);
    const failed = run(first.next, [shell("a", { status: "failed" })], home);
    expect(failed.events).toMatchObject([{ threadId: "a", kind: "failed" }]);
    expect(run(failed.next, [shell("a", { status: "failed" })], home).events).toEqual([]);
  });
});
