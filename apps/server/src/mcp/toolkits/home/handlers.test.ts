import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  HomeUnavailableError,
  RunId,
  ThreadId,
  type OrchestratorMcpThreadSendResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as FleetService from "../../../home/FleetService.ts";
import * as HomeService from "../../../home/HomeService.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const environmentId = EnvironmentId.make("hub");
const homeThreadId = ThreadId.make("home:1");
const offNote =
  "Home is off on hub. It may run in a linked environment: retry with environmentId set to one of box (box).";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "home-send", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "home-send", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const clientScope = (
  caller: Partial<McpInvocationContext.McpClientCaller> = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:claude-ai",
  thread: undefined,
  client: { sessionId: "claude-ai", label: "claude.ai", access: "full-access", ...caller },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

const homeScope: McpInvocationContext.McpInvocationScope = {
  ...clientScope(),
  client: undefined,
  thread: {
    threadId: homeThreadId,
    providerSessionId: "home-session",
    providerInstanceId: McpToolAccessTestkit.liveThreadShell(homeThreadId).providerInstanceId,
  },
};

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

/** Home's thread, and an orchestrator that records each command id once, as its receipts do. */
const setup = (options: {
  readonly home: "on" | "off";
  readonly delivery?: OrchestratorMcpThreadSendResult["delivery"];
}) => {
  const sent = new Map<string, ThreadManagement.ThreadManagementSendInput>();
  const shell = McpToolAccessTestkit.liveThreadShell(homeThreadId);
  const layer = McpHttpServer.layerHomeToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(HomeService.HomeService)({
        isHome: (threadId) => Effect.succeed(options.home === "on" && threadId === homeThreadId),
        liveThreadId:
          options.home === "on"
            ? Effect.succeed(homeThreadId)
            : Effect.fail(new HomeUnavailableError({ message: offNote })),
      }),
    ),
    Layer.provide(Layer.mock(FleetService.FleetService)({})),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(shell),
        getProjectThreadRecords: () => Effect.succeed({ thread: shell, runs: [] } as never),
        sendToThread: (input) =>
          Effect.sync(() => {
            if (!sent.has(input.commandId)) sent.set(input.commandId, input);
            return {
              run: { id: RunId.make("run:home"), status: "running" },
              delivery: options.delivery ?? "started",
            } as never;
          }),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  );
  return { layer, sent };
};

const send = (args: Record<string, unknown>, scope = clientScope()) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_home_send", arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect.each([
  { delivery: "started", expected: "started" },
  { delivery: "steered", expected: "folded" },
  { delivery: "queued", expected: "queued" },
  { delivery: "restarted", expected: "started" },
] as const)("a send Home's thread reports as $delivery is $expected", ({ delivery, expected }) => {
  const { layer, sent } = setup({ home: "on", delivery });
  return Effect.gen(function* () {
    const result = yield* send({ message: "Note for Home." });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      environmentId,
      threadId: homeThreadId,
      runId: "run:home",
      delivery: expected,
    });
    expect([...sent.values()]).toMatchObject([
      { threadId: homeThreadId, text: "Note for Home.", mode: "auto", createdBy: "agent" },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("a retry with the same clientRequestId reaches Home once", () => {
  const { layer, sent } = setup({ home: "on" });
  return Effect.gen(function* () {
    const first = yield* send({ message: "Note.", clientRequestId: "note-1" });
    const retry = yield* send({ message: "Note.", clientRequestId: "note-1" });
    expect(retry.structuredContent).toMatchObject({
      messageId: (first.structuredContent as { messageId: string }).messageId,
    });
    expect(sent.size).toBe(1);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses Home itself, read-only clients, other links' work, and an off Home", () =>
  Effect.gen(function* () {
    const { layer, sent } = setup({ home: "on" });
    yield* Effect.gen(function* () {
      expect(declaredFailure(yield* send({ message: "Hi." }, homeScope))).toEqual({
        _tag: "OrchestratorMcpFailure",
        code: "capability_denied",
        message: "Home cannot message itself.",
      });
      expect(
        declaredFailure(yield* send({ message: "Hi." }, clientScope({ access: "read-only" }))),
      ).toMatchObject({ code: "capability_denied" });
      // A link paired below full access may change only threads it started.
      expect(
        declaredFailure(
          yield* send({ message: "Hi." }, clientScope({ access: "auto", linked: true })),
        ),
      ).toMatchObject({ code: "capability_denied", message: expect.stringContaining("link") });
      expect(sent.size).toBe(0);
    }).pipe(Effect.provide(layer));

    const off = setup({ home: "off" });
    yield* Effect.gen(function* () {
      expect(declaredFailure(yield* send({ message: "Hi." }))).toMatchObject({
        code: "thread_not_found",
        message: offNote,
      });
      expect(off.sent.size).toBe(0);
    }).pipe(Effect.provide(off.layer));
  }),
);
