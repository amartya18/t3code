import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { makeProjectShell, makeRawThreadShell } from "../../test-fixtures";
import { localAgentActivityAggregate } from "./localAgentActivity";

const environmentId = EnvironmentId.make("env-1");
const nowMs = Date.parse("2026-11-26T10:00:00.000Z");
const updatedAt = DateTime.makeUnsafe(nowMs - 60_000);
const project = makeProjectShell({ id: ProjectId.make("project-1"), title: "t3code" });

describe("localAgentActivityAggregate", () => {
  it("shows only running threads the server would publish", () => {
    const thread = (id: string, input: Parameters<typeof makeRawThreadShell>[0]) =>
      makeRawThreadShell({
        id: ThreadId.make(id),
        projectId: project.id,
        title: id,
        status: "running",
        updatedAt,
        ...input,
      });
    const aggregate = localAgentActivityAggregate({
      environments: [
        {
          environmentId,
          snapshot: {
            projects: [project],
            threads: [
              thread("running", {}),
              thread("idle", { status: "idle" }),
              thread("completed", { status: "completed" }),
              thread("archived", { archivedAt: updatedAt }),
              thread("orphaned", { projectId: ProjectId.make("gone") }),
            ],
          },
        },
      ],
      nowMs,
    });

    expect(aggregate?.activeCount).toBe(1);
    expect(aggregate?.activities.map((row) => [row.threadTitle, row.projectTitle])).toEqual([
      ["running", "t3code"],
    ]);
  });

  it("is empty when no connected server has active work", () => {
    expect(
      localAgentActivityAggregate({
        environments: [{ environmentId, snapshot: { projects: [project], threads: [] } }],
        nowMs,
      }),
    ).toBeNull();
  });
});
