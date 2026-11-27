import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { useRetryEnvironment } from "../connection/useRetryEnvironment";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useEnvironmentThread } from "../../state/threads";
import { useQueuedThreadMessages } from "../../state/use-thread-outbox";
import { formatVoiceClock } from "./voiceClock";
import type { VoiceSession } from "./voiceSession";

/** The session's running time, updated once a second while shown. */
export function useVoiceClock(startedAtMs: number): string {
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a wall clock is an external system
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return formatVoiceClock(now - startedAtMs);
}

/** Whether the voice thread's machine is reachable, and what waits in the outbox meanwhile. */
export function useVoiceConnection(thread: ScopedThreadRef) {
  const runtime = useRemoteEnvironmentRuntime(thread.environmentId);
  const queued = useQueuedThreadMessages(scopedThreadKey(thread.environmentId, thread.threadId));
  const retryEnvironment = useRetryEnvironment();
  return {
    offline: runtime !== null && runtime.connectionState !== "connected",
    queued,
    retry: () => void retryEnvironment(thread.environmentId),
  };
}

/**
 * The voice thread, empty until Amar's first line creates it. A thread read before it exists
 * retries with a backoff of up to 30 s, which would hold up the first reply.
 */
export function useVoiceThread(session: VoiceSession) {
  const { thread, threadCreated } = session;
  return useEnvironmentThread(
    threadCreated ? thread.environmentId : null,
    threadCreated ? thread.threadId : null,
  );
}
