import { HomeWatch, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

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
}).annotate(Tool.Destructive, false);

export const HomeToolkit = Toolkit.make(ThreadWatchTool);
