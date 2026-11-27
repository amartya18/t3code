import { Profiler, type ReactNode } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { voiceSessionAtom } from "./voiceSession";

const SLOW_COMMIT_MS = 16;

/** Dev only: logs React renders slow enough to stall a voice turn, while a call runs. */
export function VoiceRenderProfiler(props: { readonly id: string; readonly children: ReactNode }) {
  if (!__DEV__) return props.children;
  return (
    <Profiler id={props.id} onRender={logSlowRender}>
      {props.children}
    </Profiler>
  );
}

function logSlowRender(id: string, phase: string, actualMs: number) {
  if (actualMs < SLOW_COMMIT_MS || appAtomRegistry.get(voiceSessionAtom) === null) return;
  console.log(`[voice] render ${id} ${phase} ${Math.round(actualMs)}ms`);
}
