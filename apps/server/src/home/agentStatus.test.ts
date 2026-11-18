import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { groupAgentChildren } from "./agentStatus.ts";

const hub = EnvironmentId.make("hub");
const box = EnvironmentId.make("box");
const at = (ms: number) => DateTime.makeUnsafe(ms);

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...liveThreadShell(ThreadId.make(id), { activeRunId: null }),
  status: "completed",
  ...overrides,
});

const asking = (id: string, kind: "user_input" | "command" | "auth_refresh") =>
  shell(id, {
    status: "waiting",
    pendingRuntimeRequest: { id: `request-${id}`, kind, createdAt: at(0) },
  } as Partial<OrchestrationV2ThreadShell>);

const reply = (role: "assistant" | "user", text: string) =>
  ({
    id: "message",
    role,
    text,
    updatedAt: at(0),
  }) as OrchestrationV2ThreadShell["latestVisibleMessage"];

const remoteTask = (
  threadId: string,
  status: OrchestrationV2Subagent["status"],
  updatedMs: number,
  result: string | null = null,
): OrchestrationV2Subagent =>
  ({
    origin: "app_owned",
    childThreadId: null,
    remoteChild: { environmentId: box, threadId: ThreadId.make(threadId), label: "box" },
    title: `Task ${threadId}`,
    status,
    result,
    completedAt: status === "completed" ? at(updatedMs) : null,
    updatedAt: at(updatedMs),
  }) as unknown as OrchestrationV2Subagent;

const group = (
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  subagents: ReadonlyArray<OrchestrationV2Subagent> = [],
) =>
  groupAgentChildren({
    environmentId: hub,
    shells,
    subagents,
    link: (ref, title) => `[${title}](${ref.environmentId}/${ref.threadId})`,
  });

const summary = (children: ReturnType<typeof group>) =>
  Object.fromEntries(
    Object.entries(children).map(([status, list]) => [
      status,
      list.map((child) => [child.threadId, child.attention]),
    ]),
  );

describe("groupAgentChildren", () => {
  it("groups threads here by what they need", () => {
    const children = group([
      shell("running", {
        status: "running",
        activeRunId: liveThreadShell(ThreadId.make("r")).activeRunId,
      }),
      asking("question", "user_input"),
      asking("approval", "command"),
      // A sign-in refresh is the user's alone, not something to raise.
      {
        ...asking("refreshing", "auth_refresh"),
        activeRunId: liveThreadShell(ThreadId.make("r")).activeRunId,
      },
      shell("failed", { status: "failed", latestRunCompletedAt: at(2_000) }),
      shell("idle", { status: "idle" }),
      shell("done", {
        latestRunCompletedAt: at(1_000),
        latestVisibleMessage: reply("assistant", "Fixed\n\nthe build."),
      }),
      shell("user-last", {
        latestRunCompletedAt: at(500),
        latestVisibleMessage: reply("user", "thanks"),
      }),
    ]);
    expect(summary(children)).toEqual({
      running: [
        ["running", null],
        ["refreshing", null],
      ],
      waiting: [
        ["question", "question"],
        ["approval", "approval"],
        ["idle", null],
      ],
      failed: [["failed", null]],
      recentlyFinished: [
        ["done", null],
        ["user-last", null],
      ],
    });
    expect(children.recentlyFinished[0]).toMatchObject({
      link: "[done](hub/done)",
      completedAt: "1970-01-01T00:00:01.000Z",
      latestReply: "Fixed the build.",
    });
    expect(children.recentlyFinished[1]?.latestReply).toBeNull();
  });

  it("lets the newest task speak for a linked thread and keeps a few finished, newest first", () => {
    const children = group(
      Array.from({ length: 6 }, (_, index) =>
        shell(`done-${index}`, { latestRunCompletedAt: at(index * 1_000) }),
      ),
      [
        remoteTask("followed-up", "completed", 1_000, "First answer."),
        remoteTask("followed-up", "running", 9_000),
        remoteTask("asked", "waiting", 3_000),
        remoteTask("stopped", "interrupted", 4_000),
        remoteTask("answered", "completed", 8_000, `Done. ${"x".repeat(400)}`),
      ],
    );
    expect(summary(children)).toEqual({
      running: [["followed-up", null]],
      waiting: [["asked", null]],
      failed: [["stopped", null]],
      recentlyFinished: [
        ["answered", null],
        ["done-5", null],
        ["done-4", null],
        ["done-3", null],
        ["done-2", null],
      ],
    });
    expect(children.running[0]).toMatchObject({
      environmentId: "box",
      link: "[Task followed-up](box/followed-up)",
    });
    expect(children.recentlyFinished[0]?.latestReply).toHaveLength(300);
  });
});
