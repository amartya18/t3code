import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  AppendNoteInput,
  buildCapturePrompt,
  type CaptureBatch,
  type CaptureItem,
  captureItemOf,
  checkCandidates,
  inScope,
  type ModelOutput,
  planBatches,
  threadKindOf,
} from "./memoryCaptureCandidates.ts";

const threadId = ThreadId.make("thread-a");
const meta = {
  capturedAt: "2026-11-19T12:00:00.000Z",
  environmentId: EnvironmentId.make("laptop13"),
  model: "claudeAgent/claude-haiku-5-5",
};
const thread = {
  threadId,
  title: "Wiki capture design",
  kind: "normal" as const,
  projectId: ProjectId.make("project-t3"),
  projectTitle: "t3code",
  brief: { position: 0, text: "Design capture." },
};

const shell = (id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    id: ThreadId.make(id),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    delegatedFrom: undefined,
    ...overrides,
  }) as unknown as OrchestrationV2ThreadShell;

const row = (
  type: "user_message" | "assistant_message" | "proposed_plan" | "command_execution",
  overrides: { visibility?: "local" | "inherited"; status?: string } = {},
) =>
  ({
    position: 4,
    visibility: overrides.visibility ?? "local",
    sourceThreadId: threadId,
    sourceItemId: "item-4",
    item: {
      type,
      status: overrides.status ?? "completed",
      text: "Use Haiku for capture.",
      markdown: "Plan: use Haiku.",
    },
  }) as unknown as OrchestrationV2ProjectedTurnItem;

const item = (position: number, role: CaptureItem["role"], text = "x"): CaptureItem => ({
  position,
  role,
  text,
  final: true,
});

const batch = (items: ReadonlyArray<CaptureItem>): CaptureBatch => ({
  thread,
  from: items[0]!.position,
  to: items.at(-1)!.position,
  context: [item(1, "agent")],
  items,
});

const candidate = (
  overrides: Partial<ModelOutput["candidates"][number]> = {},
): ModelOutput["candidates"][number] => ({
  topic: "projects/t3code",
  kind: "decision",
  text: "Memory capture runs on Claude Haiku.",
  decidedBy: "amar",
  evidencePositions: [5],
  ...overrides,
});

const check = (
  items: ReadonlyArray<CaptureItem>,
  ...candidates: Array<ModelOutput["candidates"][number]>
) => checkCandidates(batch(items), { candidates }, meta);

describe("threadKindOf", () => {
  it.each([
    ["home:abc", {}, "home"],
    ["home-launched:abc", {}, "home-launched"],
    [
      "child",
      {
        lineage: { parentThreadId: "p", relationshipToParent: "subagent", rootThreadId: "p" },
      },
      "subagent",
    ],
    ["delegated", { delegatedFrom: { environmentId: "hub", threadId: "p" } }, "subagent"],
    ["plain", {}, "normal"],
  ] as const)("thread %s", (id, overrides, kind) => {
    expect(threadKindOf(shell(id, overrides as Partial<OrchestrationV2ThreadShell>))).toBe(kind);
  });

  it.each([
    ["home", "home", true],
    ["home-launched", "home", true],
    ["subagent", "home", false],
    ["subagent", "subagents", true],
    ["normal", "subagents", false],
    ["normal", "all", true],
  ] as const)("%s in scope %s: %s", (kind, scope, expected) => {
    expect(inScope(kind, scope)).toBe(expected);
  });
});

describe("captureItemOf", () => {
  it.each([
    ["web user", "user_message", { createdBy: "user", creationSource: "web" }, "amar"],
    ["mobile user", "user_message", { createdBy: "user", creationSource: "mobile" }, "amar"],
    ["MCP relay", "user_message", { createdBy: "agent", creationSource: "mcp" }, "relayed"],
    ["user via MCP", "user_message", { createdBy: "user", creationSource: "mcp" }, "relayed"],
    [
      "sent by another thread",
      "user_message",
      { createdBy: "user", creationSource: "web", senderThreadId: ThreadId.make("parent") },
      "relayed",
    ],
    ["watch report", "user_message", { createdBy: "system", creationSource: "server" }, "system"],
    ["assistant", "assistant_message", { createdBy: "agent", creationSource: "provider" }, "agent"],
    ["plan", "proposed_plan", undefined, "agent"],
  ] as const)("labels a %s message", (_label, type, message, role) => {
    expect(captureItemOf(row(type), message)?.role).toBe(role);
  });

  it("skips inherited rows and non-message rows, and marks streaming items open", () => {
    expect(captureItemOf(row("user_message", { visibility: "inherited" }), undefined)).toBeNull();
    expect(captureItemOf(row("command_execution"), undefined)).toBeNull();
    expect(captureItemOf(row("assistant_message", { status: "running" }), undefined)?.final).toBe(
      false,
    );
    expect(captureItemOf(row("proposed_plan"), undefined)?.text).toBe("Plan: use Haiku.");
  });
});

describe("planBatches", () => {
  it("clips long items, splits at 60k characters, and stops before a streaming item", () => {
    const long = `${"a".repeat(3_000)}${"m".repeat(4_000)}${"z".repeat(3_000)}`;
    const items = [
      ...Array.from({ length: 12 }, (_, index) => item(10 + index, "agent", long)),
      { ...item(30, "agent"), final: false },
      item(31, "amar"),
    ];
    const batches = planBatches({ thread, preceding: [item(8, "amar"), item(9, "agent")], items });

    expect(batches.map(({ from, to }) => [from, to])).toEqual([
      [10, 18],
      [19, 21],
    ]);
    expect(batches[0]!.items[0]!.text).toBe(
      `${"a".repeat(3_000)}\n[… 4000 characters cut …]\n${"z".repeat(3_000)}`,
    );
    expect(batches[0]!.context.map((entry) => entry.position)).toEqual([8, 9]);
    expect(batches[1]!.context.map((entry) => entry.position)).toEqual([17, 18]);
  });

  it("labels every item and shows the brief as context", () => {
    const prompt = buildCapturePrompt({
      ...batch([
        item(5, "amar", "Use Haiku."),
        item(6, "agent", "Agreed."),
        { ...item(7, "relayed", "Child result."), senderThreadId: ThreadId.make("child-1") },
        item(8, "system", "Watch report."),
      ]),
    });
    expect(prompt).toContain("<brief>\nDesign capture.\n</brief>");
    expect(prompt).toContain("[pos 1] CONTEXT (do not cite)\nx");
    expect(prompt).toContain("[pos 5] AMAR\nUse Haiku.");
    expect(prompt).toContain("[pos 6] AGENT\nAgreed.");
    expect(prompt).toContain("[pos 7] RELAYED from child-1\nChild result.");
    expect(prompt).toContain("[pos 8] SYSTEM\nWatch report.");
  });
});

describe("checkCandidates", () => {
  const items = [item(5, "amar"), item(6, "agent"), item(7, "relayed"), item(8, "system")];

  it("labels each record with its source, model and timestamp", () => {
    const [record] = check(items, candidate());
    expect(record).toMatchObject({
      type: "candidate",
      v: 1,
      id: "thread-a@5-8#0",
      capturedAt: meta.capturedAt,
      writer: "t3-capture",
      sourceThreadKind: "normal",
      sourceThreadId: threadId,
      sourceThreadTitle: "Wiki capture design",
      sourceThreadLink: "[Wiki capture design](t3-thread://v2/laptop13/thread-a)",
      projectId: "project-t3",
      batch: { from: 5, to: 8 },
      evidencePositions: [5],
      amarEvidencePositions: [5],
      model: meta.model,
      dropped: null,
      note: { source: "t3-capture:thread-a@5" },
    });
  });

  it.each([
    [
      "an Amar decision stays Amar's",
      candidate(),
      { attribution: "amar", downgraded: false, dropped: null, decidedBy: "Amar" },
    ],
    [
      "a false Amar claim on an agent suggestion is downgraded",
      candidate({ evidencePositions: [6, 7] }),
      {
        attribution: "agent-proposal",
        downgraded: true,
        dropped: null,
        decidedBy: "Agent proposal, not confirmed by Amar",
      },
    ],
    [
      "an agent preference is marked unconfirmed",
      candidate({ kind: "preference", decidedBy: "agent", evidencePositions: [6] }),
      {
        attribution: "agent-proposal",
        downgraded: false,
        dropped: null,
        decidedBy: "Agent proposal, not confirmed by Amar",
      },
    ],
    [
      "a plain fact carries no decider",
      candidate({ kind: "fact", decidedBy: "none", evidencePositions: [6] }),
      { attribution: "none", downgraded: false, dropped: null, decidedBy: undefined },
    ],
    [
      "relayed-only evidence is dropped",
      candidate({ decidedBy: "agent", evidencePositions: [7, 8] }),
      { attribution: "agent-proposal", downgraded: false, dropped: "relayed-only" },
    ],
    [
      "evidence outside the batch is dropped",
      candidate({ evidencePositions: [5, 1] }),
      { dropped: "invalid-evidence" },
    ],
    [
      "missing evidence is dropped",
      candidate({ evidencePositions: [] }),
      { dropped: "invalid-evidence" },
    ],
  ] as const)("%s", (_label, input, expected) => {
    const [record] = check(items, input);
    const { decidedBy, ...fields } = expected as typeof expected & { decidedBy?: string };
    expect(record).toMatchObject(fields);
    if ("decidedBy" in expected) expect(record!.note.decided_by).toBe(decidedBy);
  });

  it.each([
    ["secret", "The key is sk-ant-api03-abcdefghijklmnop."],
    ["secret", "Use ghp_abcdefghijklmnopqrstuvwxyz0123 for pushes."],
    ["secret", "AWS key AKIAABCDEFGHIJKLMNOP is set."],
    ["secret", "Slack bot xoxb-1234567890-abcdef works."],
    ["secret", "Token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl was issued."],
    ["secret", "-----BEGIN OPENSSH PRIVATE KEY----- sits there."],
    ["secret", "Hash 0123456789abcdef0123456789abcdef is the id."],
    ["secret", "Value Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MGFiY2RlZg== was pasted."],
    ["secret", "Set password: hunter2 on the box."],
    ["transient", "The dev server runs on localhost:5173."],
    ["transient", "It listens on port 8080."],
    ["transient", "The server is pid 4242."],
    ["code-level", "The bug is in HomeWatcher.ts:120."],
    ["code-level", "Run ```vp i``` first."],
    ["schema", "x".repeat(4_001)],
  ] as const)("drops %s text: %s", (reason, text) => {
    const [record] = check(items, candidate({ kind: "fact", decidedBy: "none", text }));
    expect(record!.dropped).toBe(reason);
    if (reason === "secret") expect(record!.note.text).toBe("[redacted]");
  });

  it.each([
    ["a decision may name a version", "decision", "Fork releases are tagged v0.1.11-fork.2."],
    ["a long path is not a token", "fact", "Notes live under apps/server/src/home/memorycapture."],
    ["an ordinary sentence", "fact", "Amar runs the desktop app on an Apple Silicon Mac."],
  ] as const)("keeps a candidate when %s", (_label, kind, text) => {
    const [record] = check(items, candidate({ kind, decidedBy: "none", text }));
    expect(record!.dropped).toBeNull();
  });

  it("drops a version mentioned in passing outside a decision", () => {
    const [record] = check(
      items,
      candidate({ kind: "fact", decidedBy: "none", text: "laptop13 runs v0.1.11 now." }),
    );
    expect(record!.dropped).toBe("transient");
  });

  it("drops a topic the wiki would reject", () => {
    const [record] = check(items, candidate({ topic: "Projects/T3 Code" }));
    expect(record!.dropped).toBe("schema");
  });

  it("gives every kept record a note the wiki accepts", () => {
    const records = check(
      items,
      candidate(),
      candidate({ evidencePositions: [6] }),
      candidate({ kind: "fact", decidedBy: "none", evidencePositions: [5, 6] }),
    );
    const isNote = Schema.is(AppendNoteInput);
    expect(records.every((record) => record.dropped === null && isNote(record.note))).toBe(true);
  });
});
