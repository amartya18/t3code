import { describe, expect, it } from "vite-plus/test";

import { voiceTranscript, type TranscriptMessage } from "./voiceTranscript";

const user = (id: string, text: string): TranscriptMessage => ({ id, role: "user", text });
const agent = (id: string, text: string): TranscriptMessage => ({ id, role: "assistant", text });

describe("voiceTranscript", () => {
  it("turns Home updates into notes", () => {
    expect(
      voiceTranscript(
        [
          user("u", "Ask Home about PR 43."),
          agent("g", "I've asked Home."),
          user("h", "[Home update] Home replied: PR 43 merged."),
          user("f", '[Home update] "Fix relay" finished: done'),
          agent("s", "Home says PR 43 merged."),
        ],
        [],
        null,
      ),
    ).toEqual([
      { id: "u", kind: "user", text: "Ask Home about PR 43." },
      { id: "g", kind: "agent", text: "I've asked Home." },
      { id: "h", kind: "homeReply" },
      { id: "f", kind: "homeNote", text: '"Fix relay" finished: done' },
      { id: "s", kind: "agent", text: "Home says PR 43 merged." },
    ]);
  });

  it("appends queued messages once and keeps every line", () => {
    const sent = Array.from({ length: 8 }, (_, index) => agent(`a${index}`, `Line ${index}`));
    const lines = voiceTranscript(sent, [agent("a7", "Line 7"), user("q", "Still there?")], null);
    expect(lines.map((line) => line.id)).toEqual([
      "a0",
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
      "a7",
      "q",
    ]);
    expect(lines.at(-1)).toEqual({ id: "q", kind: "user", text: "Still there?" });
  });

  it("shows his own line in place of its outbox and thread copies", () => {
    const speech = {
      own: { text: "Merge it.", messageId: "m" },
      shown: new Map([["a", { kind: "whole" } as const]]),
    };
    const queued = [user("m", "Merge it.")];
    const inThread = [agent("a", "Ready."), user("m", "Merge it.")];

    for (const [sent, outbox] of [
      [[agent("a", "Ready.")], []],
      [[agent("a", "Ready.")], queued],
      [inThread, []],
    ] as const) {
      expect(voiceTranscript(sent, outbox, speech)).toEqual([
        { id: "a", kind: "agent", text: "Ready." },
        { id: "m", kind: "user", text: "Merge it." },
      ]);
    }
    expect(
      voiceTranscript([agent("a", "Ready.")], [], {
        ...speech,
        own: { text: "Merge it", messageId: null },
      }),
    ).toEqual([
      { id: "a", kind: "agent", text: "Ready." },
      { id: "own", kind: "user", text: "Merge it" },
    ]);
  });

  it("shows a reply as far as the voice has spoken it, and all of it without a voice", () => {
    const sent = [
      agent("played", "Done. All of it."),
      agent("playing", "First part. Second part."),
      agent("queued", "Not yet."),
    ];
    const shown = new Map([
      ["played", { kind: "whole" } as const],
      ["playing", { kind: "spoken", text: "First part." } as const],
    ]);

    expect(voiceTranscript(sent, [], { own: null, shown })).toEqual([
      { id: "played", kind: "agent", text: "Done. All of it." },
      { id: "playing", kind: "agent", text: "First part." },
    ]);
    expect(voiceTranscript(sent, [], null).map((line) => line.id)).toEqual([
      "played",
      "playing",
      "queued",
    ]);
  });
});
