import { describe, expect, it } from "vite-plus/test";

import { nextSpeechChunks, speechChunks } from "./speakable";

const REPLY = [
  "## Status",
  "",
  "Relayed to Home: merge **PR #43** once checks pass. The fix is in `apps/mobile/src/features/home-voice/endOfTurn.ts:42` at commit 80a2c4f334bd.",
  "",
  "- CI is green on [the run](https://github.com/amartya18/t3code/actions/runs/44470093259)",
  "- The relay pairing fix in home:9f3e2a1 waits for one approval",
  "",
  "| Thread | State |",
  "| --- | :---: |",
  "| fork sync | merged |",
  "",
  "```sh",
  "vp run check:changed. Do not read this.",
  "```",
  "",
  "That's everything for now.",
].join("\n");

describe("speechChunks", () => {
  it("turns a markdown reply into sentences without markup, links, hashes or paths", () => {
    expect(speechChunks(REPLY)).toEqual([
      [
        "Status.",
        "Relayed to Home: merge PR 43 once checks pass.",
        "The fix is in at commit.",
        "CI is green on the run.",
      ].join(" "),
      [
        "The relay pairing fix in waits for one approval.",
        "Thread, State.",
        "fork sync, merged.",
        "That's everything for now.",
      ].join(" "),
    ]);
  });

  it("keeps slashes that are not paths, and dates", () => {
    expect(
      speechChunks(
        "Ship it and/or revert over TCP/IP on 11/26/2026. Then read ~/notes.md and ./run.sh too.",
      ),
    ).toEqual(["Ship it and/or revert over TCP/IP on 11/26/2026. Then read and too."]);
  });

  it("does not split on decimals, versions or e.g.", () => {
    expect(speechChunks("Fork sync v0.1.11 took 2.5 s, e.g. the usual. Done")).toEqual([
      "Fork sync v0.1.11 took 2.5 s, e.g. the usual. Done.",
    ]);
  });

  it("never voices a short opener alone", () => {
    expect(speechChunks("Sure. Home says PR 43 merged an hour ago.")).toEqual([
      "Sure. Home says PR 43 merged an hour ago.",
    ]);
  });

  it("groups sentences into chunks of 100 to 150 characters", () => {
    const sentence = (index: number) =>
      `Sentence ${index} has some words to fill out about sixty characters.`;
    const reply = ["Sure.", ...Array.from({ length: 12 }, (_, index) => sentence(index + 1))].join(
      " ",
    );

    const chunks = speechChunks(reply);

    expect(chunks[0]).toBe(`Sure. ${sentence(1)} ${sentence(2)}`);
    expect(chunks.join(" ")).toBe(reply);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.length).toBeGreaterThanOrEqual(100);
      expect(chunk.length).toBeLessThanOrEqual(150);
    }
  });

  it("splits a run-on sentence longer than 150 characters at a clause", () => {
    const clause = "the build passed on laptop13 and the relay reconnected";
    const runOn = `Okay. ${Array.from({ length: 10 }, () => clause).join(", ")}.`;

    const chunks = speechChunks(runOn);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 150)).toBe(true);
    expect(chunks.join(" ").replace(/ ,/g, ",")).toBe(runOn);
  });

  it("speaks nothing for a reply that is only code or links", () => {
    expect(speechChunks("```ts\nconst a = 1.\n```\n\nhttps://example.test/a")).toEqual([]);
  });
});

describe("nextSpeechChunks", () => {
  it("starts speaking before the reply finishes, once a chunk has 100 characters", () => {
    const opener =
      "Sure, I asked Home about it. Home says PR 43 merged an hour ago and the checks passed.";
    expect(nextSpeechChunks("Sure, I asked Home about it. Home says", 0)).toEqual([]);
    expect(nextSpeechChunks(`${opener} It will`, 0)).toEqual([]);
    expect(nextSpeechChunks(`${opener} It will deploy tonight. Then`, 0)).toEqual([
      `${opener} It will deploy tonight.`,
    ]);
    expect(nextSpeechChunks(`${opener} It will deploy tonight. Then`, 1)).toEqual([]);
  });

  it("never speaks text inside a code fence that is still open", () => {
    const intro =
      "Here is the command Home ran to rebuild the app on laptop13, and it finished without any errors at all.";
    expect(nextSpeechChunks(`${intro}\n\n\`\`\`sh\nrm -rf build. Then more `, 0)).toEqual([intro]);
  });

  it("emits every chunk of the finished reply exactly once, in order, as it streams", () => {
    const sentence = (index: number) =>
      `Sentence ${index} has some words to fill out about sixty characters.`;
    const reply = `${REPLY}\n\n${Array.from({ length: 12 }, (_, index) => sentence(index)).join(" ")}`;

    const spoken: string[] = [];
    for (let length = 1; length <= reply.length; length += 1) {
      spoken.push(...nextSpeechChunks(reply.slice(0, length), spoken.length));
    }
    const beforeTheEnd = spoken.length;
    spoken.push(...speechChunks(reply).slice(spoken.length));

    expect(spoken).toEqual(speechChunks(reply));
    expect(beforeTheEnd).toBeGreaterThan(speechChunks(reply).length / 2);
  });
});
