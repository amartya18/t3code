import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { useRetryEnvironment } from "../connection/useRetryEnvironment";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { formatVoiceClock } from "./voiceClock";

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
  const queued = useThreadOutboxMessages()[scopedThreadKey(thread.environmentId, thread.threadId)];
  const retryEnvironment = useRetryEnvironment();
  return {
    offline: runtime !== null && runtime.connectionState !== "connected",
    queued: queued ?? [],
    retry: () => void retryEnvironment(thread.environmentId),
  };
}
