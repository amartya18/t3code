import type { ThreadId } from "@t3tools/contracts";

import type { ThreadFeedEntry, ThreadFeedMessage } from "../../lib/threadActivity";

export interface VoiceRelayCard {
  readonly requests: number;
  readonly minutes: number;
}

const cards = new WeakMap<ThreadFeedMessage, VoiceRelayCard>();

/** The session summary when this message is a grouped voice card. */
export function voiceRelayCard(message: ThreadFeedMessage): VoiceRelayCard | undefined {
  return cards.get(message);
}

const VOICE_PREFIX = /^[^:\n]{1,40} \(voice\):\s*/;

function relaySender(entry: ThreadFeedEntry, isVoiceThread: (id: ThreadId) => boolean) {
  if (entry.type !== "message") return null;
  const { message } = entry;
  if (message.role !== "user" || message.createdBy !== "agent") return null;
  if (message.linkedSender !== undefined || message.senderThreadId === undefined) return null;
  return isVoiceThread(message.senderThreadId) ? message.senderThreadId : null;
}

/**
 * Folds each voice thread's relays into one message at the first relay's position. Everything
 * else, Home's replies included, keeps its place.
 */
export function groupVoiceRelays(
  feed: ReadonlyArray<ThreadFeedEntry>,
  isVoiceThread: (id: ThreadId) => boolean,
): ReadonlyArray<ThreadFeedEntry> {
  const relays = new Map<ThreadId, Array<ThreadFeedMessage>>();
  for (const entry of feed) {
    const sender = relaySender(entry, isVoiceThread);
    if (sender === null || entry.type !== "message") continue;
    const list = relays.get(sender) ?? [];
    list.push(entry.message);
    relays.set(sender, list);
  }
  if (relays.size === 0) return feed;

  const grouped: Array<ThreadFeedEntry> = [];
  for (const entry of feed) {
    const sender = relaySender(entry, isVoiceThread);
    if (sender === null || entry.type !== "message") {
      grouped.push(entry);
      continue;
    }
    const messages = relays.get(sender) ?? [];
    if (messages[0] !== entry.message) continue;
    const first = Date.parse(messages[0].createdAt);
    const last = Date.parse(messages[messages.length - 1]!.createdAt);
    const message: ThreadFeedMessage = {
      ...entry.message,
      text: messages.map((relay) => relay.text.replace(VOICE_PREFIX, "").trim()).join("\n\n"),
    };
    cards.set(message, {
      requests: messages.length,
      minutes: Math.max(1, Math.ceil((last - first) / 60_000)),
    });
    grouped.push({ ...entry, message });
  }
  return grouped;
}
