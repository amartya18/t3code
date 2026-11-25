import { describe, expect, it } from "vite-plus/test";

import { buildCatchUp, renderCatchUp } from "./catchUp";
import type { HomeView, LaunchedThread } from "./homeView";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const LONG_HOME_MESSAGE = [
  "Fork sync v0.1.11 merged as 80a2c4f334bd and CI is green, see",
  "[PR 43](https://github.com/amartya18/t3code/pull/43) and thread:home-launched:mcp:launch:b0988b67e77c.",
  "The relay pairing fix in home:9f3e2a1 is waiting for **one approval** before a `git push`.",
  "More detail: https://example.test/runs/44470093259 ".repeat(8),
].join(" ");

function thread(
  index: number,
  state: LaunchedThread["state"],
  finishedHoursAgo: number | null = null,
): LaunchedThread {
  return {
    key: `env:home-launched:${index}`,
    title: `Task ${index} for commit 1a2b3c4d5e6f at https://example.test/${index}`,
    runId: `run-${index}`,
    state,
    finishedAtMs: finishedHoursAgo === null ? null : NOW - finishedHoursAgo * HOUR,
    preview: `Done with ${index}: merged deadbeef${index}1234 into main, see thread:abc-${index}. ${"Lots more words here. ".repeat(10)}`,
  };
}

const view: HomeView = {
  homeActive: true,
  homeNeedsInput: false,
  messages: [1, 2, 3, 4].map((index) => ({
    role: "assistant" as const,
    text: `Message ${index}. ${LONG_HOME_MESSAGE}`,
    createdAtMs: NOW - (5 - index) * HOUR,
    streaming: false,
  })),
  threads: [
    ...[0, 1, 2, 3].map((index) => thread(index, "running")),
    thread(4, "waiting"),
    thread(5, "needsInput"),
    thread(6, "failed", 2),
    thread(7, "needsInput"),
    ...[8, 9, 10, 11, 12, 13, 14].map((index) => thread(index, "finished", index - 7)),
    thread(15, "finished", 30),
    thread(16, "failed", 1),
    ...[17, 18, 19].map((index) => thread(index, "idle")),
  ],
};

describe("renderCatchUp", () => {
  const output = renderCatchUp(buildCatchUp(view, NOW));

  it("fits the budget and leads with what needs Amar, failed first", () => {
    expect(output.startsWith("[Catch-up] Home is working.\nNeeds you: ")).toBe(true);
    expect(output.length).toBeLessThanOrEqual(2_400);
    const needsYou = output.split("\n")[1]!;
    expect(needsYou.indexOf("Task 6")).toBeLessThan(needsYou.indexOf("Task 5"));
    expect(needsYou.indexOf("Task 16")).toBeLessThan(needsYou.indexOf("Task 5"));
    expect(needsYou).toContain("Task 7");
  });

  it("lists at most five recent finishes, newest first, with short previews", () => {
    const finished = output.split("\n").filter((line) => line.startsWith("Finished:"));
    expect(finished).toHaveLength(5);
    expect(finished[0]).toContain("Task 8");
    expect(output).not.toContain("Task 15");
    for (const line of finished) {
      const preview = line.slice(line.indexOf('": ') + 3);
      expect(preview.length).toBeLessThanOrEqual(120);
    }
  });

  it("keeps Home's last messages but none of their ids, links or hashes", () => {
    expect(output).not.toContain("Message 1.");
    expect(output).toContain("Home said: Message 2.");
    expect(output).not.toMatch(/thread:|home:|http|www\.|\]\(|\*\*|`/);
    expect(output).not.toMatch(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/i);
    expect(output).toContain("PR 43");
  });

  it("cuts the least urgent lines first when Home's messages overflow", () => {
    const crowded = renderCatchUp(
      buildCatchUp(
        {
          ...view,
          threads: Array.from({ length: 20 }, (_, index) => ({
            ...thread(index, "needsInput"),
            title: `Task ${index} ${"with a very long descriptive title ".repeat(4)}`,
          })),
        },
        NOW,
      ),
    );
    expect(crowded.length).toBeLessThanOrEqual(2_400);
    expect(crowded).toContain('"Task 19 with');
    expect(crowded).not.toContain("Message 4.");
  });
});
