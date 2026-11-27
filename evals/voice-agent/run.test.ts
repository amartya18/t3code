import { describe, expect, it } from "@effect/vitest";
import { cases } from "./cases.ts";
import { ackBlock, grade, type Block, type Sample } from "./grade.ts";

const relay = cases.find((c) => c.id === "relay")!;
const goodbye = cases.find((c) => c.id === "goodbye")!;
const send = { name: "t3_home_send", input: { message: "Amar (voice): Has PR 50 merged?" } };
const text = (body: string, at: number): Block => ({
  type: "text",
  startedAt: at,
  firstCharAt: at,
  text: body,
});
const toolUse: Block = { type: "tool_use", startedAt: 900, text: "", tool: "t3_home_send" };
const sample = (blocks: Block[], calls = [send]): Sample => ({ model: "m", blocks, calls });

describe("voice agent grader", () => {
  it("passes a relay that speaks before the tool", () => {
    expect(grade(relay, sample([text("I'll ask Home.", 800), toolUse])).pass).toBe(true);
  });

  it("fails a relay that calls the tool first", () => {
    const result = grade(relay, sample([toolUse, text("I've asked Home.", 2000)]));
    expect(result.checks.speaksBeforeTool).toBe(false);
  });

  it("does not count words in thinking as spoken", () => {
    const thinking: Block = { type: "thinking", startedAt: 700, text: "I'll ask Home." };
    expect(ackBlock(sample([thinking, toolUse]))).toBe("thinking");
    expect(grade(relay, sample([thinking, toolUse])).pass).toBe(false);
  });

  it("fails a relay without the voice prefix", () => {
    const bare = { name: "t3_home_send", input: { message: "Has PR 50 merged?" } };
    expect(grade(relay, sample([text("I'll ask Home.", 800), toolUse], [bare])).pass).toBe(false);
  });

  it("fails markdown, ids and paths", () => {
    const blocks = [text("Home says **PR #50** merged in apps/web/src/a.ts.", 800), toolUse];
    expect(grade(relay, sample(blocks)).checks.plain).toBe(false);
  });

  it("needs end call last", () => {
    expect(grade(goodbye, sample([text("Bye, Amar. [end call]", 900)], [])).pass).toBe(true);
    expect(grade(goodbye, sample([text("[end call] Bye.", 900)], [])).pass).toBe(false);
  });
});
