import { describe, expect, it } from "vite-plus/test";

import { voiceTranscript, type TranscriptMessage } from "./voiceTranscript";

const user = (id: string, text: string): TranscriptMessage => ({ id, role: "user", text });
const agent = (id: string, text: string): TranscriptMessage => ({ id, role: "assistant", text });

describe("voiceTranscript", () => {
  it("hides the catch-up and turns Home updates into notes", () => {
    expect(
      voiceTranscript(
        [
          user("c", "[Catch-up] Home is idle."),
          agent("g", "Hi. Home is idle."),
          user("u", "Ask Home about PR 43."),
          user("h", "[Home update] Home replied: PR 43 merged."),
          user("f", '[Home update] "Fix relay" finished: done'),
          agent("s", "Home says PR 43 merged."),
        ],
        [],
      ),
    ).toEqual([
      { id: "g", kind: "agent", text: "Hi. Home is idle." },
      { id: "u", kind: "user", text: "Ask Home about PR 43.", pending: false },
      { id: "h", kind: "homeReply" },
      { id: "f", kind: "homeNote", text: '"Fix relay" finished: done' },
      { id: "s", kind: "agent", text: "Home says PR 43 merged." },
    ]);
  });

  it("appends queued messages once and keeps the last six lines", () => {
    const sent = Array.from({ length: 6 }, (_, index) => agent(`a${index}`, `Line ${index}`));
    const lines = voiceTranscript(sent, [agent("a5", "Line 5"), user("q", "Still there?")]);
    expect(lines.map((line) => line.id)).toEqual(["a1", "a2", "a3", "a4", "a5", "q"]);
    expect(lines.at(-1)).toEqual({ id: "q", kind: "user", text: "Still there?", pending: true });
  });
});
