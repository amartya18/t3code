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
      "Status. Relayed to Home: merge PR 43 once checks pass.",
      [
        "The fix is in at commit.",
        "CI is green on the run.",
        "The relay pairing fix in waits for one approval.",
        "Thread, State.",
      ].join(" "),
      "fork sync, merged. That's everything for now.",
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

  it("never voices a short opener alone", () => {
    expect(speechChunks("Sure. Home says PR 43 merged an hour ago.")).toEqual([
      "Sure. Home says PR 43 merged an hour ago.",
    ]);
  });

  it("speaks a first sentence of four or more words alone", () => {
    expect(speechChunks("Sure, I can check that. Home says PR 43 merged an hour ago.")).toEqual([
      "Sure, I can check that.",
      "Home says PR 43 merged an hour ago.",
    ]);
  });

  it("joins short openers to what follows until the first chunk has four words", () => {
    expect(speechChunks("Sure. Okay, yes. Home merged it. The checks passed an hour ago.")).toEqual(
      ["Sure. Okay, yes. Home merged it.", "The checks passed an hour ago."],
    );
  });

  it("groups sentences after the first into chunks of 100 to 150 characters", () => {
    const sentence = (index: number) =>
      `Sentence ${index} has some words to fill out about sixty characters.`;
    const reply = ["Sure.", ...Array.from({ length: 12 }, (_, index) => sentence(index + 1))].join(
      " ",
    );

    const chunks = speechChunks(reply);

    expect(chunks[0]).toBe(`Sure. ${sentence(1)}`);
    expect(chunks[1]).toBe(`${sentence(2)} ${sentence(3)}`);
    expect(chunks.join(" ")).toBe(reply);
    for (const chunk of chunks.slice(1, -1)) {
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
  it("speaks the first sentence as soon as the text after it begins, then waits for 100 characters", () => {
    const first = "Sure, I asked Home about it.";
    const rest = "Home says PR 43 merged an hour ago and the checks passed.";
    expect(nextSpeechChunks("Sure, I asked Home about", 0)).toEqual([]);
    expect(nextSpeechChunks(`${first} H`, 0)).toEqual([first]);
    expect(nextSpeechChunks(`${first} ${rest} It will`, 1)).toEqual([]);
    expect(
      nextSpeechChunks(`${first} ${rest} It will deploy tonight, after a final review. Then`, 1),
    ).toEqual([`${rest} It will deploy tonight, after a final review.`]);
  });

  it("streams the first sentence once the space after its end punctuation arrives", () => {
    const reply =
      "Okay. I asked Home about it. Home says PR 43 merged an hour ago, and the checks passed.";
    const firstEnds = reply.indexOf("it.") + "it.".length;

    let firstAt: number | null = null;
    const spoken: string[] = [];
    for (let length = 1; length <= reply.length; length += 1) {
      const next = nextSpeechChunks(reply.slice(0, length), spoken.length);
      if (next.length > 0 && firstAt === null) firstAt = length;
      spoken.push(...next);
    }
    spoken.push(...speechChunks(reply).slice(spoken.length));

    expect(firstAt).toBe(firstEnds + 1);
    expect(spoken[0]).toBe("Okay. I asked Home about it.");
    expect(spoken).toEqual(speechChunks(reply));
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
