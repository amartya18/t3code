import {
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
    "Read where Home stands: whether it is on, its latest reply, and the threads it started here or handed off with delegate_task. Read-only; it never starts a turn. To ask Home something, use t3_thread_send on its threadId with mode queue, not auto, so you never steer its running turn. Threads it started in linked environments with t3_thread_launch are not tracked. If Home is off here, retry with an environmentId from linkedEnvironments.",
  parameters: HomeStatusInput,
  success: HomeStatusResult,
})
  .annotate(Tool.Title, "Read Home's status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const HomeToolkit = Toolkit.make(ThreadWatchTool, HomeStatusTool);
