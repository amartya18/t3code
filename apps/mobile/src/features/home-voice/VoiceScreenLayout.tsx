import { useNavigationState } from "@react-navigation/native";
import type { ReactNode } from "react";

import { coveredByCall, HeldRegistry } from "./callCover";
import { screenProfileId } from "./voiceRenderLog";
import { VoiceRenderProfiler } from "./voiceRenderProfiler";

/**
 * Fork hook around every root screen. A screen under the open call stops re-rendering, so while a
 * reply plays only the call updates; it also names the screen in the call's slow-render logs.
 */
export function VoiceScreenLayout(props: {
  readonly route: {
    readonly key: string;
    readonly name: string;
    readonly params?: object | undefined;
  };
  readonly children: ReactNode;
}) {
  const covered = useNavigationState((state) => coveredByCall(state.routes, props.route.key));
  return (
    <VoiceRenderProfiler id={screenProfileId(props.route)}>
      <HeldRegistry held={covered}>{props.children}</HeldRegistry>
    </VoiceRenderProfiler>
  );
}
