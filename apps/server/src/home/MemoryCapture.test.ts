import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_MEMORY_CAPTURE_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type MemoryCaptureSettings,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as MemoryCapture from "./MemoryCapture.ts";
import type { ModelOutput } from "./memoryCaptureCandidates.ts";

type Threads = ThreadManagementService.ThreadManagementService["Service"];
type StructuredRequest = { readonly prompt: string };

const projectId = ProjectId.make("project-t3");
const excludedProjectId = ProjectId.make("project-curator");
const SPANS = ["MemoryCapture.sweep", "MemoryCapture.onEvents", "MemoryCapture.captureThread"];

const makeShell = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    delegatedFrom: undefined,
    createdAt: DateTime.makeUnsafe(0),
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    activeRunId: null,
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const event = (threadId: ThreadId, status?: string) =>
  ({
    type: status === undefined ? "thread.meta-updated" : "run.updated",
    threadId,
    payload: { status },
  }) as unknown as OrchestrationV2DomainEvent;

/** Replies with one Amar decision citing every AMAR item in the prompt. */
const citeAmar = (prompt: string): ModelOutput => {
  const positions = [...prompt.matchAll(/\[pos (\d+)\] AMAR/g)].map((match) => Number(match[1]));
  return {
    candidates:
      positions.length === 0
        ? []
        : [
            {
              topic: "projects/t3code",
              kind: "decision",
              text: "Memory capture runs on Claude Haiku.",
              decidedBy: "amar",
              evidencePositions: positions,
            },
          ],
  };
};

const makeWorld = Effect.fn("makeWorld")(function* (input: {
  readonly dir: string;
  readonly settings?: Partial<MemoryCaptureSettings>;
}) {
  const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const rows = new Map<ThreadId, Array<OrchestrationV2ProjectedTurnItem>>();
  const messages = new Map<ThreadId, Array<OrchestrationV2ConversationMessage>>();
  const requests: Array<StructuredRequest> = [];
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const ended = new Map<string, Queue.Queue<void>>();
  for (const name of SPANS) ended.set(name, yield* Queue.unbounded<void>());
  let memoryCapture: MemoryCaptureSettings = {
    ...DEFAULT_MEMORY_CAPTURE_SETTINGS,
    mode: "trial",
    trialDir: input.dir,
    excludeProjectIds: [excludedProjectId],
    ...input.settings,
  };
  const settingsChanges = yield* Queue.unbounded<typeof DEFAULT_SERVER_SETTINGS>();
  /** Changes the settings the way an edit to settings.json does, and announces it. */
  const setCapture = (patch: Partial<MemoryCaptureSettings>) => {
    memoryCapture = { ...memoryCapture, ...patch };
    Queue.offerUnsafe(settingsChanges, { ...DEFAULT_SERVER_SETTINGS, memoryCapture });
  };

  const addThread = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) => {
    const shell = makeShell(id, overrides);
    shells.set(shell.id, shell);
    rows.set(shell.id, []);
    messages.set(shell.id, []);
    return shell.id;
  };
  const updateThread = (id: ThreadId, overrides: Partial<OrchestrationV2ThreadShell>) =>
    shells.set(id, { ...shells.get(id)!, ...overrides });
  const addMessage = (
    threadId: ThreadId,
    role: "user" | "assistant",
    text: string,
    origin: Partial<OrchestrationV2ConversationMessage> = {},
  ) => {
    const threadRows = rows.get(threadId)!;
    const position = threadRows.length;
    const messageId = `${threadId}-message-${position}`;
    threadRows.push({
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: `${threadId}-item-${position}`,
      item: {
        type: role === "user" ? "user_message" : "assistant_message",
        messageId,
        text,
        status: "completed",
        updatedAt: DateTime.makeUnsafe(0),
      },
    } as unknown as OrchestrationV2ProjectedTurnItem);
    messages.get(threadId)!.push({
      id: messageId,
      createdBy: role === "user" ? "user" : "agent",
      creationSource: role === "user" ? "web" : "provider",
      ...origin,
    } as unknown as OrchestrationV2ConversationMessage);
  };

  const getTimelinePage: Threads["getTimelinePage"] = (threadId, options) =>
    Effect.sync(() => {
      const visible = (rows.get(threadId) ?? []).filter(
        (row) => options.view !== "messages" || row.item.type !== "command_execution",
      );
      const matches =
        options.afterPosition !== undefined
          ? visible.filter((row) => row.position > options.afterPosition!)
          : options.beforePosition !== undefined
            ? visible.filter((row) => row.position < options.beforePosition!)
            : visible;
      const items =
        options.beforePosition !== undefined && options.afterPosition === undefined
          ? matches.slice(-options.limit)
          : matches.slice(0, options.limit);
      return {
        items,
        totalItems: visible.length,
        hasMore: options.afterPosition !== undefined && matches.length > items.length,
        hasEarlier: false,
      };
    });
  const getThreadRecords = ((
    threadId: ThreadId,
    _fields: unknown,
    filter?: { messageIds?: ReadonlyArray<string> },
  ) =>
    Effect.succeed({
      thread: shells.get(threadId),
      messages: (messages.get(threadId) ?? []).filter((message) =>
        filter?.messageIds?.includes(message.id),
      ),
    })) as unknown as Threads["getThreadRecords"];

  const generateStructured = ((request: StructuredRequest) =>
    Effect.sync(() => {
      requests.push(request);
      return citeAmar(request.prompt);
    })) as unknown as NonNullable<TextGeneration.TextGeneration["Service"]["generateStructured"]>;

  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.sync(() => shells.get(threadId) ?? null),
      getTimelinePage,
      getThreadRecords,
      listProjectThreads: () => Effect.sync(() => [...shells.values()]),
      readShellSnapshot: () =>
        Effect.succeed(
          Effect.sync(() => ({
            schemaVersion: 1,
            snapshotSequence: 0,
            threads: [...shells.values()],
            archivedThreads: [],
          })),
        ),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.sync(() => ({ ...DEFAULT_SERVER_SETTINGS, memoryCapture })),
      streamChanges: Stream.fromQueue(settingsChanges),
    }),
    Layer.mock(TextGeneration.TextGeneration)({ generateStructured }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedSome({ title: "t3code" } as Project),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("laptop13")),
    }),
  );
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (...args) => {
        end(...args);
        const queue = ended.get(span.name);
        if (queue !== undefined) Queue.offerUnsafe(queue, undefined);
      };
      return span;
    },
  });

  /** Builds the capture layer and waits for its start-up sweep. Close the scope to stop it. */
  const start = Effect.fn("start")(function* () {
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(MemoryCapture.layer.pipe(Layer.provide(dependencies)), scope).pipe(
      Effect.withTracer(tracer),
    );
    yield* Queue.take(ended.get("MemoryCapture.sweep")!);
    return scope;
  });
  /** Delivers the events as one grouped pass and waits for it. */
  const send = Effect.fn("send")(function* (...batch: Array<OrchestrationV2DomainEvent>) {
    for (const item of batch) yield* Queue.offer(events, item);
    yield* TestClock.adjust(Duration.seconds(2));
    yield* Queue.take(ended.get("MemoryCapture.onEvents")!);
  });
  const captured = Queue.take(ended.get("MemoryCapture.captureThread")!);
  const swept = Queue.take(ended.get("MemoryCapture.sweep")!);

  return {
    addThread,
    updateThread,
    addMessage,
    setCapture,
    requests,
    start,
    send,
    captured,
    swept,
  };
});

const readLines = Effect.fn("readLines")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(`${dir}/candidates.jsonl`);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; batch: { from: number; to: number } });
});
const readCursors = Effect.fn("readCursors")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return JSON.parse(yield* fs.readFileString(`${dir}/cursors.json`)) as {
    threads: Record<string, number>;
  };
});
const writeCursors = Effect.fn("writeCursors")(function* (
  dir: string,
  threads: Record<string, number>,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    `${dir}/cursors.json`,
    JSON.stringify({ v: 1, startedAt: "1970-01-01T00:00:00.000Z", threads }),
  );
});
const trialDir = Effect.fn("trialDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return path.join(yield* fs.makeTempDirectoryScoped({ prefix: "t3-capture-test-" }), "trial");
});

/** A thread with a brief, baselined, then one new exchange after the start-up sweep. */
const startedWithExchange = Effect.fn("startedWithExchange")(function* (
  world: Effect.Success<ReturnType<typeof makeWorld>>,
) {
  const threadId = world.addThread("thread-a");
  world.addMessage(threadId, "user", "Design memory capture.");
  world.addMessage(threadId, "assistant", "Here is a plan.");
  const scope = yield* world.start();
  world.addMessage(threadId, "user", "Use Haiku for capture.");
  world.addMessage(threadId, "assistant", "Done.");
  return { threadId, scope };
});

describe("MemoryCapture", () => {
  it.effect(
    "captures once a finished run has been quiet for 12 minutes, restarting on activity",
    () =>
      Effect.gen(function* () {
        const dir = yield* trialDir();
        const world = yield* makeWorld({ dir });
        const { threadId } = yield* startedWithExchange(world);

        yield* world.send(event(threadId, "completed"));
        yield* TestClock.adjust(Duration.minutes(10));
        yield* world.send(event(threadId));
        yield* TestClock.adjust(Duration.minutes(11));
        expect(world.requests).toHaveLength(0);

        yield* TestClock.adjust(Duration.minutes(2));
        yield* world.captured;
        expect(world.requests).toHaveLength(1);
        expect(world.requests[0]!.prompt).toContain("[pos 2] AMAR\nUse Haiku for capture.");
        expect(world.requests[0]!.prompt).toContain("<brief>\nDesign memory capture.\n</brief>");
        const lines = yield* readLines(dir);
        expect(lines.map((line) => [line.type, line.batch])).toEqual([
          ["candidate", { from: 2, to: 3 }],
          ["run", { from: 2, to: 3 }],
        ]);
        expect((yield* readCursors(dir)).threads[threadId]).toBe(3);
        const fs = yield* FileSystem.FileSystem;
        expect((yield* fs.readDirectory(dir)).toSorted()).toEqual([
          "candidates.jsonl",
          "cursors.json",
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("baselines the moment trial is turned on, then captures what follows", () =>
    Effect.gen(function* () {
      const dir = yield* trialDir();
      const world = yield* makeWorld({ dir, settings: { mode: "off" } });
      const threadId = world.addThread("thread-a");
      world.addMessage(threadId, "user", "Design memory capture.");
      world.addMessage(threadId, "assistant", "Here is a plan.");
      yield* world.start();

      world.setCapture({ mode: "trial" });
      yield* world.swept;
      expect((yield* readCursors(dir)).threads[threadId]).toBe(1);
      world.addMessage(threadId, "user", "Use Haiku for capture.");
      world.addMessage(threadId, "assistant", "Done.");
      yield* world.send(event(threadId, "completed"));
      yield* TestClock.adjust(Duration.minutes(13));
      yield* world.captured;
      expect(world.requests).toHaveLength(1);
      expect(world.requests[0]!.prompt).toContain("[pos 2] AMAR\nUse Haiku for capture.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("captures at once when a thread with a pending timer is settled", () =>
    Effect.gen(function* () {
      const dir = yield* trialDir();
      const world = yield* makeWorld({ dir });
      const { threadId } = yield* startedWithExchange(world);

      yield* world.send(event(threadId, "completed"));
      world.updateThread(threadId, { settledOverride: "settled" });
      yield* world.send(event(threadId));
      yield* world.captured;
      expect(world.requests).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never extracts a range twice across restarts", () =>
    Effect.gen(function* () {
      const dir = yield* trialDir();
      const world = yield* makeWorld({ dir });
      const { threadId, scope } = yield* startedWithExchange(world);
      world.updateThread(threadId, { settledOverride: "settled" });
      yield* world.send(event(threadId, "completed"));
      yield* world.captured;
      yield* Scope.close(scope, Exit.void);

      yield* world.start();
      yield* world.send(event(threadId, "completed"));
      yield* world.captured;
      expect(world.requests).toHaveLength(1);
      expect(yield* readLines(dir)).toHaveLength(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("trusts a run line written after the last cursor save", () =>
    Effect.gen(function* () {
      const dir = yield* trialDir();
      const world = yield* makeWorld({ dir });
      const threadId = world.addThread("thread-a", { settledOverride: "settled" });
      world.addMessage(threadId, "user", "Design memory capture.");
      world.addMessage(threadId, "assistant", "Here is a plan.");
      world.addMessage(threadId, "user", "Use Haiku for capture.");
      world.addMessage(threadId, "assistant", "Done.");
      yield* writeCursors(dir, { [threadId]: 1 });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        `${dir}/candidates.jsonl`,
        `${JSON.stringify({ type: "run", v: 1, threadId, batch: { from: 2, to: 3 } })}\n{"type":"cand`,
      );

      yield* world.start();
      yield* world.send(event(threadId, "completed"));
      yield* world.captured;
      expect(world.requests).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["off", "live"] as const)(
    "makes no model call and writes nothing when %s",
    (mode) =>
      Effect.gen(function* () {
        const dir = yield* trialDir();
        const world = yield* makeWorld({ dir, settings: { mode } });
        const threadId = world.addThread("thread-a", { settledOverride: "settled" });
        world.addMessage(threadId, "user", "Use Haiku for capture.");
        yield* world.start();
        yield* world.send(event(threadId, "completed"));
        yield* TestClock.adjust(Duration.minutes(13));
        expect(world.requests).toHaveLength(0);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(dir)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sweeps only in-scope threads outside excluded projects, Home first", () =>
    Effect.gen(function* () {
      const dir = yield* trialDir();
      const world = yield* makeWorld({ dir, settings: { scope: "home" } });
      const settled = { settledOverride: "settled" } as const;
      const ids = [
        world.addThread("normal", settled),
        world.addThread("home-launched:curator", { ...settled, projectId: excludedProjectId }),
        world.addThread("home-launched:task", settled),
        world.addThread("home:current", settled),
      ];
      for (const id of ids) world.addMessage(id, "user", `Remember ${id}.`);
      yield* writeCursors(dir, Object.fromEntries(ids.map((id) => [id, -1])));

      yield* world.start();
      expect(
        world.requests.map((request) => /Thread: "([^"]+)"/.exec(request.prompt)?.[1]),
      ).toEqual(["Thread home:current", "Thread home-launched:task"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("makes no model call from the sweep when no thread moved", () =>
    Effect.gen(function* () {
      const dir = yield* trialDir();
      const world = yield* makeWorld({ dir });
      const threadId = world.addThread("thread-a", { settledOverride: "settled" });
      world.addMessage(threadId, "user", "Use Haiku for capture.");
      yield* writeCursors(dir, { [threadId]: 0 });

      yield* world.start();
      yield* TestClock.adjust(Duration.hours(24));
      yield* world.swept;
      expect(world.requests).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
