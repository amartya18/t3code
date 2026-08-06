import { describe, expect, it } from "vite-plus/test";

import {
  buildChatTranscript,
  canCopyChatTranscript,
  type ChatTranscriptMessage,
} from "./transcript.ts";

const message = (role: string, text: string, streaming = false): ChatTranscriptMessage => ({
  role,
  text,
  streaming,
});

describe("buildChatTranscript", () => {
  it("formats one user and agent exchange", () => {
    expect(buildChatTranscript([message("user", "Hello"), message("assistant", "Hi there")])).toBe(
      "## User\n\nHello\n\n## Agent\n\nHi there",
    );
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

  it("writes the thread title as the transcript heading", () => {
    expect(
      buildChatTranscript([message("user", "Hello")], { title: "  Fix the flaky test  " }),
    ).toBe("# Fix the flaky test\n\n## User\n\nHello");
  });

  it("omits the heading for a missing or blank title", () => {
    expect(buildChatTranscript([message("user", "Hello")], { title: "   " })).toBe(
      "## User\n\nHello",
    );
    expect(buildChatTranscript([message("user", "Hello")], { title: null })).toBe(
      "## User\n\nHello",
    );
  });

  it("writes notes under the message text", () => {
    expect(
      buildChatTranscript([
        {
          role: "user",
          text: "Fix this issue.",
          streaming: false,
          notes: ["1 terminal context omitted", "2 images attached"],
        },
      ]),
    ).toBe("## User\n\nFix this issue.\n\n_[1 terminal context omitted]_\n_[2 images attached]_");
  });

  it("ignores blank notes", () => {
    expect(
      buildChatTranscript([{ role: "user", text: "Hello", streaming: false, notes: ["", "  "] }]),
    ).toBe("## User\n\nHello");
  });

  it("keeps a turn that carried notes only", () => {
    expect(
      buildChatTranscript([
        { role: "user", text: "  ", streaming: false, notes: ["1 terminal context omitted"] },
      ]),
    ).toBe("## User\n\n_[1 terminal context omitted]_");
  });

  it("preserves Markdown and fenced code", () => {
    const markdown = ["Use **bold** text.", "", "```ts", "const answer = 42;", "```"].join("\n");

    expect(buildChatTranscript([message("assistant", markdown)])).toBe(`## Agent\n\n${markdown}`);
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

  it("keeps the completed conversation while the agent answers", () => {
    expect(
      buildChatTranscript([
        message("user", "First question"),
        message("assistant", "First answer"),
        message("user", "Second question"),
        message("assistant", "Partial answer", true),
      ]),
    ).toBe(
      ["## User\n\nFirst question", "## Agent\n\nFirst answer", "## User\n\nSecond question"].join(
        "\n\n",
      ),
    );
  });

  it("does not truncate long transcripts", () => {
    const longText = "x".repeat(250_000);

    expect(buildChatTranscript([message("assistant", longText)])).toBe(`## Agent\n\n${longText}`);
  });
});

describe("canCopyChatTranscript", () => {
  it("requires completed user or agent text", () => {
    expect(canCopyChatTranscript([message("system", "hidden")])).toBe(false);
    expect(canCopyChatTranscript([message("assistant", "partial", true)])).toBe(false);
    expect(canCopyChatTranscript([message("user", "ready")])).toBe(true);
  });

  it("stays available while the agent answers", () => {
    expect(
      canCopyChatTranscript([message("user", "ready"), message("assistant", "partial", true)]),
    ).toBe(true);
  });

  it("rejects an empty thread", () => {
    expect(canCopyChatTranscript([])).toBe(false);
  });
});
