import {
  HomeSendInput,
  HomeSendResult,
  HomeReadInput,
  HomeReadResult,
  HomeWatch,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { homeRoutingDependencies } from "../../homeRouting.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

const ThreadWatchTool = Tool.make("t3_thread_watch", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ...homeRoutingDependencies,
  ],
  description:
    "Home only. Choose which threads in this environment wake Home. watch/unwatch one thread (threadId), or watch_all/unwatch_all for every thread here. Threads Home launches here are already watched. A watch ends when its thread is settled or archived. For a thread in a linked environment, use t3_thread_wait. Returns what Home now watches.",
  parameters: Schema.Struct({
    action: Schema.Literals(["watch", "unwatch", "watch_all", "unwatch_all"]),
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({ watchAll: Schema.Boolean, watches: Schema.Array(HomeWatch) }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const HomeReadTool = Tool.make("t3_home_read", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ...homeRoutingDependencies,
  ],
  description:
    "Read Home, the user's coordinator agent: whether it is on, its newest messages whole (default 5; older: `beforePosition=earlierPosition`), and the threads it started or handed off with delegate_task, as 300-character previews unless `fullChildren: true`. Read-only; it never starts a turn. To message Home, use t3_home_send. Threads it started in linked environments with t3_thread_launch are not tracked.",
  parameters: HomeReadInput,
  success: HomeReadResult,
})
  .annotate(Tool.Title, "Read Home")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const HomeSendTool = Tool.make("t3_home_send", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    OrchestratorMcpService.OrchestratorMcpService,
    ...homeRoutingDependencies,
  ],
  description:
    "Message Home, the user's coordinator agent that starts and tracks work across their projects. Finds Home's thread for you. If Home is idle, the message starts a turn. If Home is working, it joins that turn at Home's next tool call, without cutting off its reply or its planned tool calls. Read the reply with t3_home_read.",
  parameters: HomeSendInput,
  success: HomeSendResult,
})
  .annotate(Tool.Title, "Message Home")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const HomeToolkit = Toolkit.make(ThreadWatchTool, HomeReadTool, HomeSendTool);
