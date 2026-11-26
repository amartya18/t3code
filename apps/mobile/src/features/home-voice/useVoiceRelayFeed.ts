import { useAtomValue } from "@effect/atom-react";
import { isHomeThreadId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg, type useMessages } from "gt-react-native";

import type { ThreadFeedEntry, ThreadFeedMessage } from "../../lib/threadActivity";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { environmentThreadShells } from "../../state/threads";
import { groupVoiceRelays, voiceRelayCard } from "./groupVoiceRelays";
import { VOICE_THREAD_TAG } from "./voiceSession";

// A string, so feeds re-render only when the set of voice threads changes, not on every shell update.
const voiceThreadKeysAtom = Atom.make((get) =>
  get(environmentThreadShells.threadShellsAtom)
    .filter((shell) => shell.source.tags?.includes(VOICE_THREAD_TAG) === true)
    .map((shell) => scopedThreadKey(shell.environmentId, shell.id))
    .sort()
    .join("\n"),
).pipe(Atom.withLabel("home-voice:voice-thread-keys"));

/** Fork hook in ThreadFeed: Home's feed with each voice session's relays folded into one card. */
export function useVoiceRelayFeed(
  feed: ReadonlyArray<ThreadFeedEntry>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<ThreadFeedEntry> {
  const keys = useAtomValue(voiceThreadKeysAtom);
  if (!isHomeThreadId(threadId) || keys === "") return feed;
  const voiceKeys = new Set(keys.split("\n"));
  return groupVoiceRelays(feed, (id) => voiceKeys.has(scopedThreadKey(environmentId, id)));
}

/** The fold header's words for a voice card; undefined for any other message. */
export function voiceRelayFoldLabels(
  message: ThreadFeedMessage,
  m: ReturnType<typeof useMessages>,
): { readonly label: string; readonly summary: string } | undefined {
  const card = voiceRelayCard(message);
  if (card === undefined) return undefined;
  return {
    label: m(msg("Voice session")),
    summary: m(
      msg(
        "{requests, plural, one {{requests} request} other {{requests} requests}} · {minutes} min",
        { requests: card.requests, minutes: card.minutes },
      ),
    ),
  };
}
