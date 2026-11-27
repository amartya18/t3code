import { isHomeThreadId } from "@t3tools/contracts";

export interface ProfiledRender {
  readonly id: string;
  readonly phase: string;
  readonly actualMs: number;
}

const SLOW_COMMIT_MS = 16;

/** The profiler id for a root screen; Home's own thread is told apart from other threads. */
export function screenProfileId(route: {
  readonly name: string;
  readonly params?: object | undefined;
}): string {
  const threadId =
    route.params !== undefined && "threadId" in route.params ? route.params.threadId : undefined;
  return route.name === "Thread" && typeof threadId === "string" && isHomeThreadId(threadId)
    ? // oxlint-disable-next-line t3code/no-untranslated-copy -- a dev log id, never shown
      "Thread:home"
    : route.name;
}

/** One line for a commit slow enough to stall a voice turn, naming every profiled part's share. */
export function describeSlowCommit(renders: ReadonlyArray<ProfiledRender>): string | null {
  const slowest = renders.reduce<ProfiledRender | null>(
    (max, render) => (max === null || render.actualMs > max.actualMs ? render : max),
    null,
  );
  if (slowest === null || slowest.actualMs < SLOW_COMMIT_MS) return null;
  const parts = renders
    .filter((render) => render.actualMs >= 1)
    .sort((left, right) => right.actualMs - left.actualMs)
    .map((render) => `${render.id} ${Math.round(render.actualMs)}`);
  return `[voice] render ${slowest.phase} ${Math.round(slowest.actualMs)}ms: ${parts.join(", ")}`;
}
