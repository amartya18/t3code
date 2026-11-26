import { MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { groupVoiceRelays, voiceRelayCard } from "./groupVoiceRelays";

const HOME = ThreadId.make("home");
const VOICE_A = ThreadId.make("voice-a");
const VOICE_B = ThreadId.make("voice-b");
const WORKER = ThreadId.make("worker");
const UNLOADED = ThreadId.make("voice-unloaded");

const at = (minute: number) => new Date(Date.UTC(2026, 10, 26, 10, minute)).toISOString();

function entry(
  id: string,
  minute: number,
  input:
    | { readonly role: "assistant"; readonly text: string }
    | { readonly role: "user"; readonly text: string; readonly sender?: ThreadId },
): ThreadFeedEntry {
  const sender = input.role === "user" ? input.sender : undefined;
  return {
    type: "message",
    id,
    createdAt: at(minute),
    message: {
      id: MessageId.make(id),
      role: input.role,
      text: input.text,
      attachments: [],
      runId: null,
      streaming: false,
      visibility: "local",
      sourceThreadId: HOME,
      createdAt: at(minute),
      updatedAt: at(minute),
      ...(sender === undefined ? {} : { senderThreadId: sender, createdBy: "agent" as const }),
    },
  };
}

const isVoiceThread = (id: ThreadId) => id === VOICE_A || id === VOICE_B;

const summary = (feed: ReadonlyArray<ThreadFeedEntry>) =>
  feed.map((item) =>
    item.type === "message"
      ? { id: item.id, text: item.message.text, card: voiceRelayCard(item.message) }
      : item.id,
  );

describe("groupVoiceRelays", () => {
  it("gives two interleaved sessions two cards and keeps Home's replies in order", () => {
    const feed = [
      entry("a1", 0, { role: "user", text: "Amar (voice): Is PR 43 merged?", sender: VOICE_A }),
      entry("b1", 1, { role: "user", text: "Amar (voice): Status of the build?", sender: VOICE_B }),
      entry("r1", 2, { role: "assistant", text: "PR 43 is merged." }),
      entry("a2", 6, { role: "user", text: "Amar (voice): Approve the push.", sender: VOICE_A }),
      entry("r2", 7, { role: "assistant", text: "Approved." }),
    ];

    expect(summary(groupVoiceRelays(feed, isVoiceThread))).toEqual([
      {
        id: "a1",
        text: "Is PR 43 merged?\n\nApprove the push.",
        card: { requests: 2, minutes: 6 },
      },
      { id: "b1", text: "Status of the build?", card: { requests: 1, minutes: 1 } },
      { id: "r1", text: "PR 43 is merged.", card: undefined },
      { id: "r2", text: "Approved.", card: undefined },
    ]);
  });

  it("never groups messages from other agents or from Amar", () => {
    const feed = [
      entry("w1", 0, { role: "user", text: "Worker finished.", sender: WORKER }),
      entry("w2", 1, { role: "user", text: "Worker failed.", sender: WORKER }),
      entry("u1", 2, { role: "user", text: "Thanks" }),
    ];

    expect(groupVoiceRelays(feed, isVoiceThread)).toBe(feed);
  });

  it("leaves a relay whose sender is not loaded yet as a normal message", () => {
    const feed = [
      entry("x1", 0, { role: "user", text: "Amar (voice): Hello?", sender: UNLOADED }),
      entry("x2", 1, { role: "user", text: "Amar (voice): Anyone?", sender: UNLOADED }),
    ];

    const grouped = groupVoiceRelays(feed, isVoiceThread);
    expect(summary(grouped)).toEqual([
      { id: "x1", text: "Amar (voice): Hello?", card: undefined },
      { id: "x2", text: "Amar (voice): Anyone?", card: undefined },
    ]);
  });
});
