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
      "Status.",
      [
        "Relayed to Home: merge PR 43 once checks pass.",
        "The fix is in at commit.",
        "CI is green on the run.",
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
    ).toEqual(["Ship it and/or revert over TCP/IP on 11/26/2026.", "Then read and too."]);
  });

  it("does not split on decimals, versions or e.g.", () => {
    expect(speechChunks("Fork sync v0.1.11 took 2.5 s, e.g. the usual. Done")).toEqual([
      "Fork sync v0.1.11 took 2.5 s, e.g. the usual.",
      "Done.",
    ]);
  });

  it("voices the first sentence alone, then groups the rest into 200 to 400 characters", () => {
    const sentence = (index: number) =>
      `Sentence ${index} has some words to fill out about sixty characters.`;
    const reply = Array.from({ length: 12 }, (_, index) => sentence(index + 1)).join(" ");

    const chunks = speechChunks(reply);

    expect(chunks[0]).toBe(sentence(1));
    expect(chunks.join(" ")).toBe(reply);
    for (const chunk of chunks.slice(1, -1)) {
      expect(chunk.length).toBeGreaterThanOrEqual(200);
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
  });

  it("splits a run-on sentence longer than 400 characters at a clause", () => {
    const clause = "the build passed on laptop13 and the relay reconnected";
    const runOn = `Okay. ${Array.from({ length: 10 }, () => clause).join(", ")}.`;

    const chunks = speechChunks(runOn);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 400)).toBe(true);
    expect(chunks.join(" ").replace(/ ,/g, ",")).toBe(runOn);
  });

  it("speaks nothing for a reply that is only code or links", () => {
    expect(speechChunks("```ts\nconst a = 1.\n```\n\nhttps://example.test/a")).toEqual([]);
  });
});

describe("nextSpeechChunks", () => {
  it("starts speaking the first sentence before the reply finishes", () => {
    expect(nextSpeechChunks("Relayed to Home. It will merge PR 43 once", 0)).toEqual([
      "Relayed to Home.",
    ]);
    expect(nextSpeechChunks("Relayed to Home", 0)).toEqual([]);
    expect(nextSpeechChunks("Relayed to Home. It will merge PR 43 once", 1)).toEqual([]);
  });

  it("never speaks text inside a code fence that is still open", () => {
    expect(nextSpeechChunks("Here it is.\n\n```sh\nrm -rf build. Then more ", 0)).toEqual([
      "Here it is.",
    ]);
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
