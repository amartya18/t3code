/**
 * Wakes Home when threads it watches on its own environment change. Threads in
 * linked environments are out of its reach here; Home waits on those instead.
 */
import {
  type EnvironmentId,
  type HomeSettings,
  type HomeWatchEvent,
  isHomeLaunchedThreadId,
  isHomeThreadId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { listedThreadStatus } from "../mcp/OrchestratorMcpService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { attentionOf, readLatestReply } from "./agentStatus.ts";
import * as HomeService from "./HomeService.ts";

export interface WatchedThreadState {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly attention: string | null;
  readonly completion: number | null;
  readonly ended: boolean;
}

const UNSEEN = { attention: null, completion: null, ended: false };

export function diffWatchedThreads(input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly previous: ReadonlyMap<ThreadId, WatchedThreadState>;
  readonly changed: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly shell: OrchestrationV2ThreadShell | null;
  }>;
  readonly home: HomeSettings;
  readonly knownWatchKeys: ReadonlySet<ThreadId>;
  /** Threads created after this were seen from their start, so their first state is news. */
  readonly startedAtMs: number;
}): {
  readonly next: Map<ThreadId, WatchedThreadState>;
  readonly events: Array<HomeWatchEvent>;
} {
  const watches = new Map(
    input.home.watches
      .filter((watch) => watch.environmentId === input.environmentId)
      .map((watch) => [watch.threadId, watch]),
  );
  const next = new Map(input.previous);
  const events: Array<HomeWatchEvent> = [];
  const report = (state: WatchedThreadState, kind: HomeWatchEvent["kind"]) =>
    events.push({
      environmentId: input.environmentId,
      environmentLabel: input.environmentLabel.slice(0, 200),
      threadId: state.threadId,
      title: state.title.slice(0, 300),
      kind,
    });
  for (const { threadId, shell } of input.changed) {
    const watch = watches.get(threadId);
    const seen = input.previous.get(threadId);
    if (shell === null || shell.deletedAt !== null) {
      next.delete(threadId);
      const stillWatched = seen === undefined ? input.knownWatchKeys.has(threadId) : !seen.ended;
      if (watch !== undefined && stillWatched) {
        report(seen ?? { threadId, title: shell?.title ?? "", ...UNSEEN }, "ended");
      }
      continue;
    }
    // Home never wakes for itself, an older Home, or subagent plumbing.
    if (isHomeThreadId(shell.id) || shell.lineage.relationshipToParent === "subagent") continue;
    if (!input.home.watchAll && watch === undefined && !isHomeLaunchedThreadId(threadId)) {
      next.delete(threadId);
      continue;
    }
    const createdSinceStart = DateTime.toEpochMillis(shell.createdAt) > input.startedAtMs;
    const prior = seen ?? (createdSinceStart ? UNSEEN : undefined);
    const attention = attentionOf(shell);
    const finished = listedThreadStatus(shell) === "completed";
    const completion =
      finished && shell.latestRunCompletedAt != null
        ? DateTime.toEpochMillis(shell.latestRunCompletedAt)
        : (prior?.completion ?? null);
    const state: WatchedThreadState = {
      threadId,
      title: shell.title,
      attention: attention?.key ?? null,
      completion,
      ended: shell.archivedAt !== null,
    };
    next.set(threadId, state);
    if (prior === undefined) {
      const archivedWhileDown =
        state.ended && watch !== undefined && input.knownWatchKeys.has(threadId);
      if (archivedWhileDown) report(state, "ended");
      continue;
    }
    if (state.ended) {
      if (!prior.ended && watch !== undefined) report(state, "ended");
      continue;
    }
    if (attention !== null && attention.key !== prior.attention) {
      report(state, attention.kind);
    } else if (
      completion !== null &&
      (prior.completion === null || completion > prior.completion)
    ) {
      report(state, "completed");
    }
  }
  return { next, events };
}

/** Quotes a finished or failed thread's last reply, so Home needn't read the thread. */
export const withLatestReplies = Effect.fn("HomeWatcher.withLatestReplies")(function* (
  threads: Parameters<typeof readLatestReply>[0],
  events: ReadonlyArray<HomeWatchEvent>,
  changed: ReadonlyArray<{ readonly shell: OrchestrationV2ThreadShell | null }>,
) {
  return yield* Effect.forEach(events, (event) => {
    const shell = changed.find((entry) => entry.shell?.id === event.threadId)?.shell;
    if ((event.kind !== "completed" && event.kind !== "failed") || shell == null) {
      return Effect.succeed(event);
    }
    return readLatestReply(threads, shell).pipe(
      // The quote is a convenience; the event still goes out without it.
      Effect.orElseSucceed(() => null),
      Effect.map((detail) => (detail === null ? event : { ...event, detail })),
    );
  });
});

/** Thread changes gather this long before Home is woken with all of them. */
const BATCH_WINDOW = Duration.millis(1_500);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const home = yield* HomeService.HomeService;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const startedAtMs = DateTime.toEpochMillis(yield* DateTime.now);

    // Watches that exist at start-up only set a baseline.
    const startup = yield* settings.getSettings.pipe(
      Effect.map((current) => current.home),
      Effect.orElseSucceed(() => null),
    );
    const knownWatchKeys = new Set(startup?.watches.map((watch) => watch.threadId) ?? []);
    let previous: ReadonlyMap<ThreadId, WatchedThreadState> = new Map();

    const evaluate = Effect.fn("HomeWatcher.evaluate")(function* (
      threadIds: ReadonlySet<ThreadId>,
    ) {
      const current = yield* settings.getSettings.pipe(Effect.map((value) => value.home));
      if (current.threadId === null) {
        previous = new Map();
        return;
      }
      const changed = yield* Effect.forEach([...threadIds], (threadId) =>
        threads.getThreadShell(threadId).pipe(Effect.map((shell) => ({ threadId, shell }))),
      );
      const { label } = yield* environment.getDescriptor;
      const { next, events } = diffWatchedThreads({
        environmentId,
        environmentLabel: label,
        previous,
        changed,
        home: current,
        knownWatchKeys,
        startedAtMs,
      });
      // A failed report leaves the last state, so the next change retries it.
      if (events.length > 0) {
        yield* home.report({ events: yield* withLatestReplies(threads, events, changed) });
      }
      previous = next;
    });

    // Start-up watches whose threads ended while the server was down end now.
    yield* evaluate(knownWatchKeys).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Home start-up watch pass failed", cause)),
    );
    yield* orchestrator.streamDomainEvents.pipe(
      Stream.map((event) => event.threadId),
      Stream.groupedWithin(1_024, BATCH_WINDOW),
      Stream.runForEach((batch) =>
        evaluate(new Set(batch)).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Home watch pass failed", cause)),
        ),
      ),
      Effect.catchCause((cause) => Effect.logWarning("Home watch stream failed", cause)),
      Effect.forkScoped,
    );
  }),
);
