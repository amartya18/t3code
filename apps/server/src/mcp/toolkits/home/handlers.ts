import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HomeService from "../../../home/HomeService.ts";
import { callerIsHome, readHomeChangeCaller } from "../../homeRouting.ts";
import { assertSameLink } from "../../linkOrigin.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { loadCaller, readCaller, unavailable } from "../../threadAccess.ts";
import { HomeToolkit } from "./tools.ts";

const DELIVERY = {
  started: "started",
  steered: "folded",
  queued: "queued",
  // Only a restart send restarts, and Home's sends are auto.
  restarted: "started",
} as const;

export const HomeHandlersLive = McpToolAccess.toLayer(HomeToolkit, {
  t3_home_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { scope } = yield* readCaller();
      const home = yield* HomeService.HomeService;
      return yield* home
        .status({
          link: (ref, title) =>
            McpInvocationContext.threadLinkFor(
              { ...scope, environmentId: ref.environmentId },
              ref.threadId,
              title,
            ),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
    }),
  ),
  // Home's thread is known only here, so its target checks run here too.
  t3_home_send: McpToolAccess.writesThreads(
    () => [],
    (input) =>
      Effect.gen(function* () {
        if (yield* callerIsHome())
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Home cannot message itself.",
          });
        const threadId = yield* (yield* HomeService.HomeService).liveThreadId.pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "thread_not_found", message: error.message }),
          ),
        );
        const caller = yield* loadCaller();
        const target = yield* caller.threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(unavailable));
        if (target !== null) yield* assertSameLink(caller, target);
        const sent = yield* (yield* OrchestratorMcpService.OrchestratorMcpService).sendToThread(
          caller.scope,
          {
            threadId,
            message: input.message,
            mode: "auto",
            ...(input.clientRequestId === undefined
              ? {}
              : { clientRequestId: input.clientRequestId }),
          },
        );
        return {
          environmentId: caller.scope.environmentId,
          threadId,
          link:
            sent.link ?? McpInvocationContext.threadLinkFor(caller.scope, threadId, target?.title),
          messageId: sent.messageId,
          runId: sent.runId,
          delivery: DELIVERY[sent.delivery],
        };
      }),
  ),
  t3_thread_watch: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      if (!(yield* callerIsHome()))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Home can watch threads.",
        });
      const { scope } = yield* readHomeChangeCaller();
      const homeThreadId = scope.thread?.threadId;
      if (homeThreadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only Home can watch threads.",
        });
      const home = yield* HomeService.HomeService;
      const environmentId = scope.environmentId;
      const { threadId } = input;
      if ((input.action === "watch" || input.action === "unwatch") && threadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `${input.action} needs threadId.`,
        });
      const next = yield* home
        .updateWatches(homeThreadId, (current) => {
          switch (input.action) {
            case "watch_all":
              return { ...current, watchAll: true };
            case "unwatch_all":
              return { ...current, watchAll: false };
            case "watch":
              return HomeService.addWatch(current, {
                environmentId,
                threadId: threadId!,
                reason: "requested",
              });
            case "unwatch":
              return HomeService.removeWatch(current, { environmentId, threadId: threadId! });
          }
        })
        .pipe(Effect.mapError(unavailable));
      return { watchAll: next.watchAll, watches: next.watches };
    }),
  ),
});
