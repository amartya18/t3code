/**
 * Fork-only memory capture. Once a thread goes quiet, or is settled, a
 * tool-less model call proposes lasting facts from its new messages and
 * `memoryCaptureCandidates.ts` checks them. Trial mode appends the results to
 * a local JSONL file and never touches the wiki.
 */
import {
  type MemoryCaptureSettings,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  buildCapturePrompt,
  captureItemOf,
  checkCandidates,
  type ContextItem,
  inScope,
  KIND_RANK,
  ModelOutput,
  planBatches,
  type RunRecord,
  threadKindOf,
} from "./memoryCaptureCandidates.ts";

/** A thread is captured once it has been this long without activity. */
const QUIET = Duration.minutes(12);
const SWEEP_EVERY = Duration.hours(24);
const BATCH_WINDOW = Duration.millis(1_500);
const PAGE_LIMIT = 200;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled"]);
const DEFAULT_MODEL = createModelSelection(
  ProviderInstanceId.make("claudeAgent"),
  "claude-haiku-5-5",
);

const CursorFile = Schema.Struct({
  v: Schema.Literal(1),
  startedAt: Schema.String,
  threads: Schema.Record(ThreadId, Schema.Int),
});
const decodeCursorFile = Schema.decodeUnknownOption(Schema.fromJsonString(CursorFile));
const encodeCursorFile = Schema.encodeEffect(Schema.fromJsonString(CursorFile));
const RunLine = Schema.Struct({
  type: Schema.Literal("run"),
  threadId: ThreadId,
  batch: Schema.Struct({ to: Schema.Int }),
});
const decodeRunLine = Schema.decodeUnknownOption(Schema.fromJsonString(RunLine));

interface TrialState {
  readonly dir: string;
  readonly startedAtMs: number;
  readonly startedAt: string;
  readonly cursors: Map<ThreadId, number>;
}

interface PendingCapture {
  lastActivityMs: number;
  settled: Deferred.Deferred<void>;
}

const isEnded = (shell: OrchestrationV2ThreadShell) =>
  shell.settledOverride === "settled" || shell.archivedAt !== null || shell.deletedAt !== null;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const projects = yield* ProjectService.ProjectService;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;

    const captureLock = yield* Semaphore.make(1);
    const stateLock = yield* Semaphore.make(1);
    const timers = yield* FiberMap.make<ThreadId>();
    const pending = new Map<ThreadId, PendingCapture>();
    let state: TrialState | null = null;
    let wasLive = false;

    const nowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

    /** The trial settings, or null when capture is off. Live is not built, so it acts as off. */
    const trialSettings = Effect.fn("MemoryCapture.trialSettings")(function* () {
      const { memoryCapture } = yield* settings.getSettings;
      const live = memoryCapture.mode === "live";
      if (live && !wasLive) {
        // Going live needs a Cloudflare service token, an append_note dedupe key and an outbox.
        yield* Effect.logWarning(
          "memoryCapture.mode is live, which is not built yet; nothing is captured",
        );
      }
      wasLive = live;
      return memoryCapture.mode === "trial" ? memoryCapture : null;
    });

    const trialDirOf = (config: MemoryCaptureSettings) =>
      config.trialDir ??
      path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "t3-capture", "trial");

    const capturable = (config: MemoryCaptureSettings, shell: OrchestrationV2ThreadShell) =>
      inScope(threadKindOf(shell), config.scope) &&
      !config.excludeProjectIds.includes(shell.projectId);

    const newestPosition = (threadId: ThreadId, view: "messages" | "activity") =>
      threads
        .getTimelinePage(threadId, { beforePosition: Number.POSITIVE_INFINITY, limit: 1, view })
        .pipe(Effect.map((page) => page.items[0]));

    const saveCursors = Effect.fn("MemoryCapture.saveCursors")(function* (trial: TrialState) {
      const file = path.join(trial.dir, "cursors.json");
      const body = yield* encodeCursorFile({
        v: 1,
        startedAt: trial.startedAt,
        threads: Object.fromEntries(trial.cursors),
      });
      yield* fs.writeFileString(`${file}.tmp`, `${body}\n`);
      yield* fs.rename(`${file}.tmp`, file);
    });

    /** Appends the lines with one write and syncs them before the caller moves a cursor. */
    const appendLines = Effect.fn("MemoryCapture.appendLines")(function* (
      trial: TrialState,
      lines: ReadonlyArray<unknown>,
    ) {
      const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(path.join(trial.dir, "candidates.jsonl"), { flag: "a" });
          yield* file.writeAll(new TextEncoder().encode(text));
          yield* file.sync;
        }),
      );
    });

    /**
     * Loads cursors for the trial dir, reconciled with the run lines in
     * candidates.jsonl so a crash between append and cursor save never repeats
     * an extraction. The first load baselines every thread at its current end.
     */
    const loadState = Effect.fn("MemoryCapture.loadState")(
      function* (dir: string) {
        if (state?.dir === dir) return state;
        yield* fs.makeDirectory(dir, { recursive: true });
        const cursorPath = path.join(dir, "cursors.json");
        const saved = (yield* fs.exists(cursorPath))
          ? decodeCursorFile(yield* fs.readFileString(cursorPath))
          : Option.none();
        if (Option.isSome(saved)) {
          const cursors = new Map(Object.entries(saved.value.threads) as Array<[ThreadId, number]>);
          const candidatesPath = path.join(dir, "candidates.jsonl");
          if (yield* fs.exists(candidatesPath)) {
            for (const line of (yield* fs.readFileString(candidatesPath)).split("\n")) {
              const run = decodeRunLine(line);
              if (Option.isNone(run)) continue;
              const { threadId, batch } = run.value;
              cursors.set(threadId, Math.max(cursors.get(threadId) ?? -1, batch.to));
            }
          }
          state = {
            dir,
            startedAt: saved.value.startedAt,
            startedAtMs: DateTime.toEpochMillis(DateTime.makeUnsafe(saved.value.startedAt)),
            cursors,
          };
          return state;
        }
        const startedAtMs = yield* nowMs;
        const listed = yield* threads.listProjectThreads({ includeSubagents: true });
        const cursors = new Map<ThreadId, number>();
        for (const entry of listed) {
          cursors.set(entry.id, (yield* newestPosition(entry.id, "activity"))?.position ?? -1);
        }
        state = {
          dir,
          startedAtMs,
          startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAtMs)),
          cursors,
        };
        yield* saveCursors(state);
        return state;
      },
      // One loader at a time, so a start-up sweep and a settings change never baseline twice.
      (effect) => stateLock.withPermits(1)(effect),
    );

    /** A thread seen for the first time starts at its end, unless it began after the trial did. */
    const cursorFor = Effect.fn("MemoryCapture.cursorFor")(function* (
      trial: TrialState,
      shell: OrchestrationV2ThreadShell,
    ) {
      const known = trial.cursors.get(shell.id);
      if (known !== undefined) return known;
      const cursor =
        DateTime.toEpochMillis(shell.createdAt) >= trial.startedAtMs
          ? -1
          : ((yield* newestPosition(shell.id, "activity"))?.position ?? -1);
      trial.cursors.set(shell.id, cursor);
      yield* saveCursors(trial);
      return cursor;
    });

    const readRowsAfter = Effect.fn("MemoryCapture.readRowsAfter")(function* (
      threadId: ThreadId,
      cursor: number,
    ) {
      const rows: Array<OrchestrationV2ProjectedTurnItem> = [];
      let after = cursor;
      while (true) {
        const page = yield* threads.getTimelinePage(threadId, {
          afterPosition: after,
          limit: PAGE_LIMIT,
          view: "messages",
        });
        rows.push(...page.items);
        const last = page.items.at(-1);
        if (!page.hasMore || last === undefined) return rows;
        after = last.position;
      }
    });

    const contextItemOf = (row: OrchestrationV2ProjectedTurnItem): ContextItem | null => {
      const text = captureItemOf({ ...row, visibility: "local" }, undefined)?.text;
      return text === undefined ? null : { position: row.position, text };
    };

    const captureOne = Effect.fn("MemoryCapture.captureOne")(function* (
      config: MemoryCaptureSettings,
      shell: OrchestrationV2ThreadShell,
    ) {
      if (shell.deletedAt !== null || !capturable(config, shell)) return;
      const trial = yield* loadState(trialDirOf(config));
      const cursor = yield* cursorFor(trial, shell);
      const rows = yield* readRowsAfter(shell.id, cursor);
      if (rows.length === 0) return;

      const messageIds = rows.flatMap((row) =>
        row.visibility === "local" &&
        (row.item.type === "user_message" || row.item.type === "assistant_message")
          ? [row.item.messageId]
          : [],
      );
      const messages = new Map<string, OrchestrationV2ConversationMessage>();
      if (messageIds.length > 0) {
        const records = yield* threads.getThreadRecords(shell.id, ["messages"], { messageIds });
        for (const message of records.messages) messages.set(message.id, message);
      }
      const items = rows.flatMap((row) => {
        const messageId =
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.messageId
            : undefined;
        const item = captureItemOf(
          row,
          messageId === undefined ? undefined : messages.get(messageId),
        );
        return item === null ? [] : [item];
      });
      const preceding =
        cursor < 0
          ? []
          : (yield* threads.getTimelinePage(shell.id, {
              beforePosition: cursor + 1,
              limit: 2,
              view: "messages",
            })).items.flatMap((row) => contextItemOf(row) ?? []);
      const firstRows = yield* threads.getTimelinePage(shell.id, { limit: 10, view: "messages" });
      const briefRow = firstRows.items.find((row) => row.item.type === "user_message");
      const briefItem = briefRow === undefined ? null : contextItemOf(briefRow);
      const project = yield* projects.getById(shell.projectId);

      const batches = planBatches({
        thread: {
          threadId: shell.id,
          title: shell.title,
          kind: threadKindOf(shell),
          projectId: shell.projectId,
          projectTitle: Option.match(project, { onNone: () => "", onSome: (value) => value.title }),
          brief: briefItem,
        },
        preceding,
        items,
      });
      const modelSelection = config.modelSelection ?? DEFAULT_MODEL;
      const model = `${modelSelection.instanceId}/${modelSelection.model}`;
      const environmentId = yield* environment.getEnvironmentId;

      for (const batch of batches) {
        const startedMs = yield* nowMs;
        const prompt = buildCapturePrompt(batch);
        const output = yield* Effect.scoped(
          Effect.gen(function* () {
            const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-capture-" });
            return yield* textGeneration.generateStructured!({
              cwd,
              prompt,
              outputSchema: ModelOutput,
              modelSelection,
              projectId: shell.projectId,
            });
          }),
        ).pipe(Effect.result);
        if (output._tag === "Failure") {
          // Nothing is appended and the cursor stays, so the next trigger or sweep retries.
          yield* Effect.logWarning("memory capture extraction failed", {
            threadId: shell.id,
            batch: { from: batch.from, to: batch.to },
            cause: output.failure,
          });
          return;
        }
        const endedMs = yield* nowMs;
        const capturedAt = DateTime.formatIso(DateTime.makeUnsafe(endedMs));
        const records = checkCandidates(batch, output.success, {
          capturedAt,
          environmentId,
          model,
        });
        const kept = records.filter((record) => record.dropped === null).length;
        const run: RunRecord = {
          type: "run",
          v: 1,
          threadId: shell.id,
          sourceThreadKind: batch.thread.kind,
          batch: { from: batch.from, to: batch.to },
          at: capturedAt,
          promptChars: prompt.length,
          candidates: records.length,
          kept,
          dropped: records.length - kept,
          durationMs: endedMs - startedMs,
          model,
        };
        yield* appendLines(trial, [...records, run]);
        trial.cursors.set(shell.id, batch.to);
        yield* saveCursors(trial);
      }
      // Rows past the last citable item, such as inherited ones, need no model call.
      const lastRow = rows.at(-1)!.position;
      if (items.every((item) => item.final) && lastRow > trial.cursors.get(shell.id)!) {
        trial.cursors.set(shell.id, lastRow);
        yield* saveCursors(trial);
      }
    });

    /** Captures the thread and its native subagent children, which have no runs to trigger on. */
    const captureThread = Effect.fn("MemoryCapture.captureThread")(
      function* (threadId: ThreadId) {
        const config = yield* trialSettings();
        if (config === null) return;
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null) return;
        yield* captureOne(config, shell);
        const family = yield* yield* threads.readShellSnapshot({ familyOf: threadId });
        for (const child of family.threads) {
          if (
            child.lineage.parentThreadId === threadId &&
            child.lineage.relationshipToParent === "subagent"
          ) {
            yield* captureOne(config, child);
          }
        }
      },
      (effect, threadId) =>
        captureLock
          .withPermits(1)(effect)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("memory capture failed", { threadId, cause }),
            ),
          ),
    );

    /** Waits until the thread has been quiet for QUIET, or settles, then captures; loops on new activity. */
    const captureWhenQuiet = Effect.fn("MemoryCapture.captureWhenQuiet")(function* (
      threadId: ThreadId,
    ) {
      while (true) {
        const entry = pending.get(threadId);
        if (entry === undefined) return;
        const remaining = entry.lastActivityMs + Duration.toMillis(QUIET) - (yield* nowMs);
        if (remaining > 0) {
          const settled = yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(remaining)).pipe(Effect.as(false)),
            Deferred.await(entry.settled).pipe(Effect.as(true)),
          );
          if (!settled) continue;
        }
        const seen = entry.lastActivityMs;
        yield* captureThread(threadId);
        if (entry.lastActivityMs === seen) {
          pending.delete(threadId);
          return;
        }
        entry.settled = yield* Deferred.make<void>();
      }
    });

    const startTimer = Effect.fn("MemoryCapture.startTimer")(function* (
      threadId: ThreadId,
      lastActivityMs: number,
    ) {
      const entry = pending.get(threadId);
      if (entry !== undefined) {
        entry.lastActivityMs = Math.max(entry.lastActivityMs, lastActivityMs);
        return;
      }
      pending.set(threadId, { lastActivityMs, settled: yield* Deferred.make<void>() });
      yield* FiberMap.run(timers, threadId, captureWhenQuiet(threadId));
    });

    const onEvents = Effect.fn("MemoryCapture.onEvents")(function* (
      batch: ReadonlyArray<{ readonly threadId: ThreadId; readonly terminalRun: boolean }>,
    ) {
      const config = yield* trialSettings();
      if (config === null) return;
      const at = yield* nowMs;
      const terminal = new Set(batch.filter((event) => event.terminalRun).map((e) => e.threadId));
      for (const threadId of new Set(batch.map((event) => event.threadId))) {
        const entry = pending.get(threadId);
        if (entry === undefined && !terminal.has(threadId)) continue;
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null || !capturable(config, shell)) continue;
        yield* startTimer(threadId, at);
        if (isEnded(shell)) yield* Deferred.succeed(pending.get(threadId)!.settled, undefined);
      }
    });

    const sweep = Effect.fn("MemoryCapture.sweep")(function* () {
      const config = yield* trialSettings();
      if (config === null) return;
      const trial = yield* loadState(trialDirOf(config));
      const listed = (yield* threads.listProjectThreads({ includeSubagents: true }))
        .map((entry) => ({ entry, kind: threadKindOf(entry) }))
        .filter(
          ({ entry, kind }) =>
            inScope(kind, config.scope) && !config.excludeProjectIds.includes(entry.projectId),
        )
        .toSorted((left, right) => KIND_RANK[left.kind] - KIND_RANK[right.kind]);
      for (const { entry } of listed) {
        if (pending.has(entry.id)) continue;
        const newest = yield* newestPosition(entry.id, "messages");
        if (newest === undefined) continue;
        const known = trial.cursors.get(entry.id);
        if (known !== undefined && known >= newest.position) continue;
        const shell = yield* threads.getThreadShell(entry.id);
        if (shell === null) continue;
        if ((yield* cursorFor(trial, shell)) >= newest.position) continue;
        if (isEnded(shell)) {
          yield* captureThread(entry.id);
        } else if (shell.activeRunId === null) {
          yield* startTimer(entry.id, DateTime.toEpochMillis(newest.item.updatedAt));
        }
      }
    });

    yield* forkParked(
      sweep().pipe(
        Effect.catchCause((cause) => Effect.logWarning("memory capture sweep failed", cause)),
        Effect.repeat(Schedule.spaced(SWEEP_EVERY)),
      ),
    );
    // Turning trial on while the server runs baselines and sweeps at once, so
    // activity from that moment on is captured.
    yield* forkParked(
      settings.streamChanges.pipe(
        Stream.map(({ memoryCapture }) =>
          memoryCapture.mode === "trial" ? trialDirOf(memoryCapture) : null,
        ),
        Stream.changes,
        Stream.runForEach((dir) =>
          dir === null || state?.dir === dir
            ? Effect.void
            : sweep().pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("memory capture sweep failed", cause),
                ),
              ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("memory capture settings stream failed", cause),
        ),
      ),
    );
    yield* forkParked(
      orchestrator.streamDomainEvents.pipe(
        Stream.map((event) => ({
          threadId: event.threadId,
          terminalRun:
            event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status),
        })),
        Stream.groupedWithin(1_024, BATCH_WINDOW),
        Stream.runForEach((batch) =>
          onEvents(batch).pipe(
            Effect.catchCause((cause) => Effect.logWarning("memory capture pass failed", cause)),
          ),
        ),
        Effect.catchCause((cause) => Effect.logWarning("memory capture stream failed", cause)),
      ),
    );
  }),
);
