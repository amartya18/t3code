import type { ReactNode } from "react";

import { screenProfileId } from "./voiceRenderLog";
import { VoiceRenderProfiler } from "./voiceRenderProfiler";

/** Fork hook around every root screen: names the screen in the call's slow-render logs. */
export function VoiceScreenLayout(props: {
  readonly route: { readonly name: string; readonly params?: object | undefined };
  readonly children: ReactNode;
}) {
  return (
    <VoiceRenderProfiler id={screenProfileId(props.route)}>{props.children}</VoiceRenderProfiler>
  );
}
