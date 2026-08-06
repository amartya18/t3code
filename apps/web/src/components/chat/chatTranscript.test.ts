import { buildChatTranscript } from "@t3tools/client-runtime/conversation";
import { describe, expect, it } from "vite-plus/test";

import { toChatTranscriptMessages } from "./chatTranscript";

const promptWithTerminalContext = [
  "Fix this issue.",
  "",
  "<terminal_context>",
  "- Terminal 1 lines 2-3:",
  "  2 | error",
  "  3 | details",
  "</terminal_context>",
].join("\n");

const promptWithBothContexts = [
  promptWithTerminalContext,
  "",
  "<element_context>",
  "- button:",
  "  Save",
  "</element_context>",
].join("\n");

describe("toChatTranscriptMessages", () => {
  it("strips terminal context from a user prompt and names it", () => {
    expect(
      toChatTranscriptMessages([
        { role: "user", text: promptWithTerminalContext, streaming: false },
      ]),
    ).toEqual([
      {
        role: "user",
        text: "Fix this issue.",
        streaming: false,
        notes: ["1 terminal context omitted"],
      },
    ]);
  });

  it("counts terminal and element context separately", () => {
    const [message] = toChatTranscriptMessages([
      { role: "user", text: promptWithBothContexts, streaming: false },
    ]);

    expect(message?.text).toBe("Fix this issue.");
    expect(message?.notes).toEqual(["1 terminal context omitted", "1 page element omitted"]);
  });

  it("marks attachments on both roles", () => {
    expect(
      toChatTranscriptMessages([
        { role: "user", text: "Look at this", streaming: false, attachments: [{}, {}] },
        { role: "assistant", text: "Looks fine", streaming: false, attachments: [{}] },
      ]),
    ).toEqual([
      { role: "user", text: "Look at this", streaming: false, notes: ["2 images attached"] },
      { role: "assistant", text: "Looks fine", streaming: false, notes: ["1 image attached"] },
    ]);
  });

  it("leaves plain messages untouched", () => {
    expect(
      toChatTranscriptMessages([
        { role: "user", text: "Plain question", streaming: false },
        { role: "assistant", text: "Plain answer", streaming: true },
      ]),
    ).toEqual([
      { role: "user", text: "Plain question", streaming: false },
      { role: "assistant", text: "Plain answer", streaming: true },
    ]);
  });

  it("builds a transcript that carries the notes under each message", () => {
    expect(
      buildChatTranscript(
        toChatTranscriptMessages([
          { role: "user", text: promptWithTerminalContext, streaming: false },
          { role: "assistant", text: "Fixed it.", streaming: false },
        ]),
        { title: "Fix the flaky test" },
      ),
    ).toBe(
      [
        "# Fix the flaky test",
        "## User\n\nFix this issue.\n\n_[1 terminal context omitted]_",
        "## Agent\n\nFixed it.",
      ].join("\n\n"),
    );
  });
});
