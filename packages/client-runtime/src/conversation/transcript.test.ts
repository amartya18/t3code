import { describe, expect, it } from "vite-plus/test";

import {
  buildChatTranscript,
  canCopyChatTranscript,
  hasCopyableChatTranscriptMessages,
  type ChatTranscriptMessage,
} from "./transcript";

const message = (
  role: string,
  text: string,
  streaming = false,
): ChatTranscriptMessage => ({ role, text, streaming });

describe("buildChatTranscript", () => {
  it("formats one user and agent exchange", () => {
    expect(
      buildChatTranscript([message("user", "Hello"), message("assistant", "Hi there")]),
    ).toBe("## User\n\nHello\n\n## Agent\n\nHi there");
  });

  it("keeps multiple turns in input order", () => {
    expect(
      buildChatTranscript([
        message("user", "First question"),
        message("assistant", "First answer"),
        message("user", "Second question"),
        message("assistant", "Second answer"),
      ]),
    ).toBe(
      [
        "## User\n\nFirst question",
        "## Agent\n\nFirst answer",
        "## User\n\nSecond question",
        "## Agent\n\nSecond answer",
      ].join("\n\n"),
    );
  });

  it("preserves Markdown and fenced code", () => {
    const markdown = ["Use **bold** text.", "", "```ts", "const answer = 42;", "```"].join(
      "\n",
    );

    expect(buildChatTranscript([message("assistant", markdown)])).toBe(
      `## Agent\n\n${markdown}`,
    );
  });

  it("trims outer whitespace and excludes blank messages", () => {
    expect(
      buildChatTranscript([
        message("user", " \n\t "),
        message("user", "\n  Keep this  \n"),
        message("assistant", ""),
      ]),
    ).toBe("## User\n\nKeep this");
  });

  it("excludes system, tool, and streaming messages", () => {
    expect(
      buildChatTranscript([
        message("system", "Internal instructions"),
        message("tool", "Tool output"),
        message("assistant", "Partial answer", true),
        message("user", "Complete question"),
      ]),
    ).toBe("## User\n\nComplete question");
  });

  it("keeps provider-visible terminal and element context blocks", () => {
    const prompt = [
      "Fix this issue.",
      "",
      "<terminal_context>",
      "- Terminal 1 lines 2-3:",
      "  2 | error",
      "  3 | details",
      "</terminal_context>",
      "",
      "<element_context>",
      "- button:",
      "  Save",
      "</element_context>",
    ].join("\n");

    expect(buildChatTranscript([message("user", prompt)])).toBe(`## User\n\n${prompt}`);
  });

  it("does not truncate long transcripts", () => {
    const longText = "x".repeat(250_000);

    expect(buildChatTranscript([message("assistant", longText)])).toBe(
      `## Agent\n\n${longText}`,
    );
  });
});

describe("hasCopyableChatTranscriptMessages", () => {
  it("requires completed user or agent text", () => {
    expect(hasCopyableChatTranscriptMessages([message("system", "hidden")])).toBe(false);
    expect(hasCopyableChatTranscriptMessages([message("assistant", "partial", true)])).toBe(false);
    expect(hasCopyableChatTranscriptMessages([message("user", "ready")])).toBe(true);
  });
});

describe("canCopyChatTranscript", () => {
  it("disables copying during the active turn", () => {
    const messages = [message("user", "ready")];

    expect(canCopyChatTranscript(messages, true)).toBe(false);
    expect(canCopyChatTranscript(messages, false)).toBe(true);
  });

  it("disables copying when any message is still streaming", () => {
    expect(
      canCopyChatTranscript(
        [message("user", "ready"), message("assistant", "partial", true)],
        false,
      ),
    ).toBe(false);
  });

  it("disables copying when the transcript has no content", () => {
    expect(canCopyChatTranscript([message("system", "hidden")], false)).toBe(false);
  });
});
