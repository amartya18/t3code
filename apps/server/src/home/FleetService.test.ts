import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FleetInput,
  type ExecutionEnvironmentDescriptor,
  type Project as ContractProject,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetService from "./FleetService.ts";

const actor = { environmentId: EnvironmentId.make("hub"), threadId: ThreadId.make("home") };
const threadId = ThreadId.make("worker");
const approvalId = RuntimeRequestId.make("approval");
const questionId = RuntimeRequestId.make("question");
const toolCallId = RuntimeRequestId.make("tool-call");

const shell = (
  id: string,
  projectId: string,
  updatedAt: number,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    createdBy: "user",
    creationSource: "web",
    status: "idle",
    activityRunStatus: null,
    latestRunId: null,
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    settledOverride: null,
    settledAt: null,
    pendingRuntimeRequest: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: null },
    visibleItemCount: 0,
    deletedAt: null,
    createdAt: DateTime.makeUnsafe(updatedAt),
    updatedAt: DateTime.makeUnsafe(updatedAt),
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const projectDefault = { type: "worktree", baseRef: "origin/main", startFromOrigin: true } as const;

const setup = () => {
  const fleetShells = [
    // The test clock starts at 0, so this one wakes in a minute.
    shell("snoozed", "a", 0, {
      snoozedAt: DateTime.makeUnsafe(0),
      snoozedUntil: DateTime.makeUnsafe(60_000),
    }),
    shell("older", "a", 1),
    shell("newer", "b", 2),
  ];
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const launched: Array<string> = [];
  const workspaces: Array<ThreadLaunch.ThreadLaunchWorkspaceStrategy> = [];
  const customModes: Array<string | undefined> = [];
  const layer = FleetService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        ServerSettings.layerTest(),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("studio"),
          } as ExecutionEnvironmentDescriptor),
        }),
        Layer.mock(Project.ProjectService)({
          getById: (projectId) =>
            Effect.succeedSome({
              id: projectId,
              workspaceRoot: `/${projectId}`,
            } as ContractProject),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          homeRoot: Effect.succeed("/home"),
          isInHomeFolder: (candidate) =>
            Effect.succeed(candidate === "/home" || candidate.startsWith("/home/")),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          defaultWorkspaceStrategy: () => Effect.succeed(projectDefault),
          launch: (input) => {
            launched.push(input.commandId);
            workspaces.push(input.workspaceStrategy);
            customModes.push(input.customMode);
            const customMode =
              input.customMode === undefined
                ? null
                : { status: "on", skill: input.customMode, updatedAt: "2026-01-01T00:00:00Z" };
            return Effect.succeed({
              threadId: input.threadId,
              projection: {
                thread: { ...shell(String(input.threadId), "a", 1), customMode },
                runs: [],
              },
              resumed: false,
            } as never);
          },
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(shell(id, "a", 1)),
          // The store lists threads newest first; the shells come back in any order.
          listProjectThreads: () =>
            Effect.succeed(fleetShells.toReversed().map(({ id }) => ({ id }) as never)),
          getShellSnapshot: (options) =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: fleetShells.filter(({ id }) => options?.threadIds?.includes(id) ?? true),
              archivedThreads: [],
            }),
          getThreadRecords: () =>
            Effect.succeed({
              runtimeRequests: [
                { id: approvalId, kind: "command", status: "pending" },
                { id: questionId, kind: "user_input", status: "pending" },
                { id: toolCallId, kind: "dynamic_tool_call", status: "pending" },
              ],
              turnItems: [],
            } as never),
          dispatch: (command) => {
            dispatched.push(command);
            return Effect.succeed({ sequence: 7, storedEvents: [] } as never);
          },
        }),
      ),
    ),
  );
  return { layer, dispatched, launched, workspaces, customModes };
};

it.effect("lists threads from every project, newest first, with snooze state", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const result = yield* fleet.execute({ actor, request: { op: "threads.list", input: {} } });
    expect(result).toMatchObject({
      projectId: null,
      threads: [
        {
          threadId: "newer",
          link: "[newer](t3-thread://v2/studio/newer)",
          projectId: "b",
          snoozed: false,
          snoozedUntil: null,
        },
        { threadId: "older", projectId: "a" },
        { threadId: "snoozed", snoozed: true, snoozedUntil: "1970-01-01T00:01:00.000Z" },
      ],
    });
    const snoozed = yield* fleet.execute({
      actor,
      request: { op: "threads.list", input: { snoozed: true } },
    });
    expect(snoozed).toMatchObject({ total: 1, threads: [{ threadId: "snoozed" }] });
  }).pipe(Effect.provide(layer));
});

it.effect("approves a pending request with a decision", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const listed = yield* fleet.execute({
      actor,
      request: { op: "requests.list", input: { threadId } },
    });
    expect(listed).toEqual({ requestIds: [questionId], approvalRequestIds: [approvalId] });
    yield* fleet.execute({
      actor,
      request: {
        op: "requests.respond",
        input: { threadId, requestId: approvalId, decision: "accept" },
      },
    });
    expect(dispatched).toMatchObject([
      { type: "runtime-request.respond", threadId, requestId: approvalId, decision: "accept" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses to answer a question without answers", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "requests.respond",
          input: { threadId, requestId: questionId, decision: "accept" },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(dispatched).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a scratch launch that also names a workspace", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "threads.launch",
          input: {
            scratch: true,
            title: "Scratch work",
            workspaceStrategy: { type: "existing_worktree", worktreePath: "/elsewhere" },
          },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
  }).pipe(Effect.provide(layer));
});

it.effect("refuses to launch into a Home folder, as a project or a worktree", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const launch = (input: Omit<FleetInput<"threads.launch">, "title">) =>
      fleet
        .execute({ actor, request: { op: "threads.launch", input: { title: "Worker", ...input } } })
        .pipe(Effect.asVoid, Effect.flip);
    expect((yield* launch({ projectId: ProjectId.make("home") })).code).toBe("invalid_request");
    const worktree = yield* launch({
      projectId: ProjectId.make("app"),
      workspaceStrategy: { type: "existing_worktree", worktreePath: "/home/notes" },
    });
    expect(worktree.code).toBe("invalid_request");
  }).pipe(Effect.provide(layer));
});

it.effect("keys a retried rename by its target thread", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const rename = (target: string) =>
      fleet
        .execute({
          actor,
          request: {
            op: "threads.rename",
            input: { threadId: ThreadId.make(target), title: "New title", clientRequestId: "r1" },
          },
        })
        .pipe(Effect.ignore);
    yield* rename("a");
    yield* rename("a");
    yield* rename("b");
    const ids = dispatched.map((command) => command.commandId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses a decision for a request that is not an approval", () => {
  const { layer, dispatched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "requests.respond",
          input: { threadId, requestId: toolCallId, decision: "accept" },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
    expect(dispatched).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("a retried Home launch keeps its command, so it replays", () => {
  const { layer, launched } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const launch = fleet.execute({
      actor,
      request: {
        op: "threads.launch",
        input: {
          threadId: ThreadId.make("home-launched:one"),
          projectId: ProjectId.make("a"),
          title: "Worker",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        },
      },
    });
    yield* launch;
    yield* launch;
    expect(launched).toHaveLength(2);
    expect(launched[1]).toBe(launched[0]);
  }).pipe(Effect.provide(layer));
});

it.effect("a Home launch that names no workspace gets the project's default", () => {
  const { layer, workspaces } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const launch = (workspaceStrategy?: ThreadLaunch.ThreadLaunchWorkspaceStrategy) =>
      fleet.execute({
        actor,
        request: {
          op: "threads.launch",
          input: {
            projectId: ProjectId.make("a"),
            title: "Worker",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
          },
        },
      });
    yield* launch();
    yield* launch({ type: "root" });
    expect(workspaces).toEqual([projectDefault, { type: "root" }]);
  }).pipe(Effect.provide(layer));
});

it.effect("only launches with a Home launch id it was given", () => {
  const { layer } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const error = yield* fleet
      .execute({
        actor,
        request: {
          op: "threads.launch",
          input: { threadId: ThreadId.make("home:fake"), scratch: true, title: "Worker" },
        },
      })
      .pipe(Effect.asVoid, Effect.flip);
    expect(error.code).toBe("invalid_request");
  }).pipe(Effect.provide(layer));
});

it.effect("a Home launch starts with the custom mode it names, and reports it", () => {
  const { layer, customModes } = setup();
  return Effect.gen(function* () {
    const fleet = yield* FleetService.FleetService;
    const launch = (customMode?: string) =>
      fleet.execute({
        actor,
        request: {
          op: "threads.launch",
          input: {
            projectId: ProjectId.make("a"),
            title: "Worker",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            ...(customMode === undefined ? {} : { customMode }),
          },
        },
      });
    const named = yield* launch("t3-pstack:poteto-mode");
    const plain = yield* launch();
    expect(customModes).toEqual(["t3-pstack:poteto-mode", undefined]);
    expect(named).toMatchObject({ customMode: "t3-pstack:poteto-mode" });
    expect(plain).toMatchObject({ customMode: null });
  }).pipe(Effect.provide(layer));
});
