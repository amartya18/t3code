/** Where an agent's threads stand, shared by Home's watcher and its status read. */
import type {
  AgentStatusChild,
  AgentStatusChildren,
  AgentStatusKind,
  EnvironmentId,
  HomeWatchEvent,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const REPLY_PREVIEW_LENGTH = 300;
/** A `full` reply stops here, the most `t3_thread_read` returns of one item. */
const FULL_REPLY_LENGTH = 20_000;
/** Failed and finished threads past this many, newest first, are left out. */
const RECENT_LIMIT = 5;

type AttentionKind = Extract<HomeWatchEvent["kind"], "approval" | "question" | "failed">;

export function attentionOf(
  shell: OrchestrationV2ThreadShell,
): { readonly kind: AttentionKind; readonly key: string } | null {
  const request = shell.pendingRuntimeRequest;
  if (request?.kind === "user_input") return { kind: "question", key: `request:${request.id}` };
  if (request !== null && request.kind !== "auth_refresh") {
    return { kind: "approval", key: `request:${request.id}` };
  }
  if (shell.status === "failed") return { kind: "failed", key: `failed:${shell.latestRunId}` };
  return null;
}

/** One line of at most 300 characters, or with `full` the reply as written. */
function replyPreview(text: string, full = false): string {
  const line = full ? text.trim() : text.replace(/\s+/g, " ").trim();
  const max = full ? FULL_REPLY_LENGTH : REPLY_PREVIEW_LENGTH;
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** The last assistant reply of the thread's latest run, previewed unless `full`. Reads that run's messages only. */
export const readLatestReply = Effect.fn("agentStatus.readLatestReply")(function* (
  threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "getThreadRecords">,
  shell: Pick<OrchestrationV2ThreadShell, "id" | "latestRunId">,
  full = false,
) {
  if (shell.latestRunId === null) return null;
  const { messages } = yield* threads.getThreadRecords(shell.id, ["messages"], {
    messageRunIds: [shell.latestRunId],
    messageRoles: ["assistant"],
  });
  const reply = messages.findLast((message) => message.text.trim() !== "");
  return reply === undefined ? null : replyPreview(reply.text, full);
});

export type ThreadLinker = (
  ref: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  title: string,
) => string;

const ACTIVE_SHELL_STATUSES: ReadonlySet<OrchestrationV2ThreadShell["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

function shellStatus(
  shell: OrchestrationV2ThreadShell,
  attention: ReturnType<typeof attentionOf>,
): AgentStatusKind {
  if (attention?.kind === "question" || attention?.kind === "approval") return "waiting";
  if (attention?.kind === "failed") return "failed";
  if (shell.activeRunId !== null || ACTIVE_SHELL_STATUSES.has(shell.status)) return "running";
  if (shell.status === "completed") return "finished";
  // A thread that never ran waits for its first message.
  if (shell.status === "idle") return "waiting";
  return "failed";
}

function shellChild(
  environmentId: EnvironmentId,
  shell: OrchestrationV2ThreadShell,
  latestReply: string | null,
  link: ThreadLinker,
): AgentStatusChild {
  const attention = attentionOf(shell);
  const status = shellStatus(shell, attention);
  const ended = status === "finished" || status === "failed";
  return {
    environmentId,
    threadId: shell.id,
    title: shell.title,
    link: link({ environmentId, threadId: shell.id }, shell.title),
    status,
    attention:
      attention?.kind === "question" || attention?.kind === "approval" ? attention.kind : null,
    completedAt:
      ended && shell.latestRunCompletedAt != null
        ? DateTime.formatIso(shell.latestRunCompletedAt)
        : null,
    latestReply,
  };
}

const TASK_STATUS: Record<OrchestrationV2Subagent["status"], AgentStatusKind> = {
  pending: "running",
  idle: "running",
  running: "running",
  waiting: "waiting",
  completed: "finished",
  failed: "failed",
  cancelled: "failed",
  interrupted: "failed",
};

function remoteTaskChild(
  task: OrchestrationV2Subagent,
  link: ThreadLinker,
  full: boolean,
): ReadonlyArray<AgentStatusChild> {
  const remote = task.remoteChild;
  if (task.origin !== "app_owned" || remote === undefined) return [];
  const title = remote.title ?? task.title ?? remote.label;
  return [
    {
      environmentId: remote.environmentId,
      threadId: remote.threadId,
      title,
      link: link(remote, title),
      status: TASK_STATUS[task.status],
      // Its questions and approvals are answered where it runs; which one is not known here.
      attention: null,
      completedAt: task.completedAt === null ? null : DateTime.formatIso(task.completedAt),
      latestReply: task.result === null ? null : replyPreview(task.result, full),
    },
  ];
}

const newestFirst = (left: AgentStatusChild, right: AgentStatusChild) =>
  (right.completedAt ?? "").localeCompare(left.completedAt ?? "");

/**
 * Groups an agent's threads: those on its own environment, and the tasks it
 * handed to linked environments. Several tasks can follow up one thread
 * there; the newest one speaks for it.
 */
export function groupAgentChildren(input: {
  readonly environmentId: EnvironmentId;
  readonly shells: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly replies: ReadonlyMap<ThreadId, string | null>;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly link: ThreadLinker;
  readonly full: boolean;
}): AgentStatusChildren {
  const byThread = new Map<string, AgentStatusChild>();
  const add = (child: AgentStatusChild) => {
    const key = `${child.environmentId}\u0000${child.threadId}`;
    if (!byThread.has(key)) byThread.set(key, child);
  };
  for (const shell of input.shells) {
    add(shellChild(input.environmentId, shell, input.replies.get(shell.id) ?? null, input.link));
  }
  const newestTasks = input.subagents.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
  );
  const tasks = newestTasks.flatMap((task) => remoteTaskChild(task, input.link, input.full));
  for (const child of tasks) add(child);
  const children = [...byThread.values()];
  const having = (status: AgentStatusKind) => children.filter((child) => child.status === status);
  return {
    running: having("running"),
    waiting: having("waiting"),
    failed: having("failed").toSorted(newestFirst).slice(0, RECENT_LIMIT),
    recentlyFinished: having("finished").toSorted(newestFirst).slice(0, RECENT_LIMIT),
  };
}
