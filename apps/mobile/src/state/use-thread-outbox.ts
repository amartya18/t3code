import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, MessageId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { environmentShell } from "./shell";
import { threadOutboxManager } from "./thread-outbox";
import { flattenQueuedThreadMessages, type QueuedThreadMessage } from "./thread-outbox-model";

export const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> => {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !statuses.has(environmentId)) {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
      }
    }
    return statuses;
  },
).pipe(Atom.withLabel("mobile:thread-outbox:shell-statuses"));

/** Do not deliver tasks still open in an editor or whose latest edits failed to save; their queued payloads are stale. */
export const editingQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:editing-message-ids"),
);

/** Messages being sent now: at most one per thread, the head of its queue. */
export const dispatchingQueuedMessageIdsAtom = Atom.make<
  Readonly<Partial<Record<MessageId, true>>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:dispatching-message-ids"));

/** Messages waiting out a retry backoff, which can repeat for as long as the failure lasts. */
export const retryingQueuedMessageIdsAtom = Atom.make<Readonly<Partial<Record<MessageId, true>>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:retrying-message-ids"));

export function holdEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (current[messageId]) {
    return;
  }
  appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true });
}

export function releaseEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (!current[messageId]) {
    return;
  }
  const next = { ...current };
  delete next[messageId];
  appAtomRegistry.set(editingQueuedMessageIdsAtom, next);
}

const EMPTY_QUEUE: ReadonlyArray<QueuedThreadMessage> = [];
const emptyQueueAtom = Atom.make(EMPTY_QUEUE);

const sameMessages = (
  left: ReadonlyArray<QueuedThreadMessage>,
  right: ReadonlyArray<QueuedThreadMessage>,
) => left.length === right.length && left.every((message, index) => message === right[index]);

// Every outbox change rebuilds each thread's queue array; readers of one slice keep the previous
// array when its messages are the same, so a send to one thread re-renders no other thread's screen.
export const queuedThreadMessagesAtom = Atom.family((threadKey: string) =>
  Atom.make((get): ReadonlyArray<QueuedThreadMessage> => {
    const queue = get(threadOutboxManager.queuedMessagesByThreadKeyAtom)[threadKey] ?? EMPTY_QUEUE;
    const previous = Option.getOrUndefined(get.self<ReadonlyArray<QueuedThreadMessage>>());
    return previous !== undefined && sameMessages(previous, queue) ? previous : queue;
  }).pipe(Atom.withLabel(`mobile:thread-outbox:queue:${threadKey}`)),
);

export function useQueuedThreadMessages(
  threadKey: string | null,
): ReadonlyArray<QueuedThreadMessage> {
  return useAtomValue(threadKey === null ? emptyQueueAtom : queuedThreadMessagesAtom(threadKey));
}

/** Queued thread creations; follow-ups to threads that exist leave it unchanged. */
export const queuedCreationMessagesAtom = Atom.make((get): ReadonlyArray<QueuedThreadMessage> => {
  const creations = flattenQueuedThreadMessages(
    get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).filter((message) => message.creation !== undefined);
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<QueuedThreadMessage>>());
  return previous !== undefined && sameMessages(previous, creations) ? previous : creations;
}).pipe(Atom.withLabel("mobile:thread-outbox:queued-creations"));

export const queuedThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const [threadKey, queue] of Object.entries(
    get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  )) {
    if (queue.some((message) => message.creation === undefined)) {
      keys.add(threadKey);
    }
  }
  const previous = Option.getOrUndefined(get.self<ReadonlySet<string>>());
  return previous?.size === keys.size && [...keys].every((key) => previous.has(key))
    ? previous
    : keys;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:queued-thread-keys"));

export function useQueuedThreadKeys(): ReadonlySet<string> {
  return useAtomValue(queuedThreadKeysAtom);
}
