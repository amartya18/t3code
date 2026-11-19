import {
  HomeSendInput,
  HomeSendResult,
  HomeStatusInput,
  HomeStatusResult,
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

const HomeStatusTool = Tool.make("t3_home_status", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ...homeRoutingDependencies,
  ],
  description:
    "Read where Home stands: whether it is on, its latest reply, and the threads it started here or handed off with delegate_task. Replies are 300-character previews; `full: true` returns them whole. Read-only; it never starts a turn. To ask Home something, use t3_home_send. Threads it started in linked environments with t3_thread_launch are not tracked. If Home is off here, retry with an environmentId from linkedEnvironments.",
  parameters: HomeStatusInput,
  success: HomeStatusResult,
})
  .annotate(Tool.Title, "Read Home's status")
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
    "Message Home, the user's coordinator agent that starts and tracks work across their projects. Finds Home's thread for you. If Home is idle, the message starts a turn. If Home is working, it joins that turn at Home's next tool call, without cutting off its reply or its planned tool calls. Read the reply with t3_home_status. If Home is off here, retry with an environmentId from the error.",
  parameters: HomeSendInput,
  success: HomeSendResult,
})
  .annotate(Tool.Title, "Message Home")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const HomeToolkit = Toolkit.make(ThreadWatchTool, HomeStatusTool, HomeSendTool);
