import type { OrchestrationV2AppThread, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";

const VOICE_THREAD_TAG = "voice";

/** Threads tagged `voice` by the phone's voice call; their replies stream as they arrive. */
export class VoiceThreads extends Context.Reference<{
  readonly has: (threadId: string) => boolean;
  /** A run's thread can predate the tag landing, so it only ever adds. */
  readonly noteRunThread: (thread: Pick<OrchestrationV2AppThread, "id" | "tags">) => void;
  readonly noteStoredEvents: (events: ReadonlyArray<OrchestrationV2StoredEvent>) => void;
}>("t3/orchestration-v2/VoiceThreads", {
  defaultValue: () => {
    const threadIds = new Set<string>();
    return {
      has: (threadId) => threadIds.has(threadId),
      noteRunThread: (thread) => {
        if (thread.tags?.includes(VOICE_THREAD_TAG)) threadIds.add(thread.id);
      },
      noteStoredEvents: (events) => {
        for (const { event } of events) {
          if (event.type !== "thread.tags-updated") continue;
          if (event.payload.tags?.includes(VOICE_THREAD_TAG)) threadIds.add(event.threadId);
          else threadIds.delete(event.threadId);
        }
      },
    };
  },
}) {}
