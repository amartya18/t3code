import {
  type FleetInput,
  type FleetOperation,
  type FleetRequest,
  type FleetResult,
  isHomeThreadId,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FleetService from "../home/FleetService.ts";
import * as HomeService from "../home/HomeService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertFullAccess, readCaller } from "./threadAccess.ts";

/** Services a tool needs to declare when it routes Home calls. */
export const homeRoutingDependencies = [
  HomeService.HomeService,
  FleetService.FleetService,
] as const;

/**
 * Whether the calling thread is Home. Read on every call. A credential that
 * cannot control threads, or a client outside a thread, is never Home, so the
 * tool's own capability check still runs first.
 */
export const callerIsHome = Effect.fn("mcp.callerIsHome")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration") || scope.thread === undefined) return false;
  const home = yield* HomeService.HomeService;
  return yield* home.isHome(scope.thread.threadId);
});

/**
 * Tools Home may run in a linked environment. They go over the link like any
 * thread's call; its other tools, such as deletes, stay on its own environment.
 */
export const HOME_ROUTED_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "t3_project_list",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_interrupt",
  "t3_thread_organize",
  "t3_thread_update",
  "t3_pending_request",
]);

/** Whether each operation changes state. A new operation must pick a side. */
const CHANGES_STATE = {
  capabilities: false,
  "projects.list": false,
  "threads.list": false,
  "threads.read": false,
  "requests.list": false,
  "requests.read": false,
  "threads.launch": true,
  "threads.send": true,
  "threads.interrupt": true,
  "threads.organize": true,
  "threads.rename": true,
  "requests.respond": true,
} satisfies Record<FleetOperation, boolean>;

/**
 * Reads the caller for a change Home makes. A change needs a live Home run in
 * full-access/default mode, so switching Home to plan or a narrower runtime
 * mode makes it read-only everywhere.
 */
export const readHomeChangeCaller = Effect.fn("mcp.readHomeChangeCaller")(function* () {
  const context = yield* readCaller();
  yield* assertFullAccess(context, "Home makes changes only in full-access/default mode.");
  return context;
});

/** Runs a fleet operation as Home on its own environment. */
export const runAsHome = Effect.fn("mcp.runAsHome")(function* <Op extends FleetOperation>(
  op: Op,
  input: FleetInput<Op>,
) {
  const { scope } = CHANGES_STATE[op] ? yield* readHomeChangeCaller() : yield* readCaller();
  // Checked again here, right before acting: Home may have been turned off
  // while the tool did earlier work.
  if (scope.thread === undefined || !(yield* callerIsHome())) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Only Home can act with the user's reach.",
    });
  }
  const result = yield* (yield* FleetService.FleetService).execute({
    actor: { environmentId: scope.environmentId, threadId: scope.thread.threadId },
    // The pairing of op and input is what FleetInput<Op> guarantees.
    request: { op, input } as FleetRequest,
  });
  return result as FleetResult<Op>;
});

/**
 * Runs a tool call from Home with its reach over every project here. Returns
 * None for any other caller, which keeps its calling-project reach.
 */
export const routeHome = Effect.fn("mcp.routeHome")(function* <Op extends FleetOperation>(
  op: Op,
  input: FleetInput<Op>,
) {
  if (yield* callerIsHome()) return Option.some(yield* runAsHome(op, input));
  return Option.none<FleetResult<Op>>();
});

const HOME_THREAD_TOOLS = {
  read: "Home's thread is read with t3_home_read.",
  send: "Message Home with t3_home_send, which finds its thread.",
} as const;

/** Points a client at the Home tools, which read Home's thread whole and send to its current one. */
export const refuseHomeThread = (threadId: ThreadId, use: keyof typeof HOME_THREAD_TOOLS) =>
  isHomeThreadId(threadId)
    ? Effect.fail(
        new OrchestratorMcpFailure({ code: "invalid_request", message: HOME_THREAD_TOOLS[use] }),
      )
    : Effect.void;
