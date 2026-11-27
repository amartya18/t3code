import { Profiler, type ReactNode } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { describeSlowCommit, type ProfiledRender } from "./voiceRenderLog";
import { voiceSessionAtom } from "./voiceSession";

/** Dev only: logs React commits slow enough to stall a voice turn, while a call runs. */
export function VoiceRenderProfiler(props: { readonly id: string; readonly children: ReactNode }) {
  if (!__DEV__) return props.children;
  return (
    <Profiler id={props.id} onRender={recordRender}>
      {props.children}
    </Profiler>
  );
}

// Every profiler in one commit reports the same commit time, so a commit logs as one line.
const commits = new Map<number, ProfiledRender[]>();

function recordRender(
  id: string,
  phase: string,
  actualMs: number,
  _baseMs: number,
  _startTime: number,
  commitTime: number,
) {
  if (appAtomRegistry.get(voiceSessionAtom) === null) return;
  const renders = commits.get(commitTime);
  if (renders !== undefined) {
    renders.push({ id, phase, actualMs });
    return;
  }
  commits.set(commitTime, [{ id, phase, actualMs }]);
  queueMicrotask(() => {
    const line = describeSlowCommit(commits.get(commitTime) ?? []);
    commits.delete(commitTime);
    if (line !== null) console.log(line);
  });
}
