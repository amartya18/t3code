import { useGT } from "gt-react";
import { type LucideIcon, PenLineIcon } from "lucide-react";

import { isMacPlatform } from "../lib/utils";
import {
  finishMarkMode,
  getMarkModeBridge,
  startMarkMode,
  useMarkModePhase,
} from "./markModeSession";

/** Fork-only: a mode the composer can switch on. Another mode is one more entry in `useComposerModes`. */
export type ComposerMode = {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly shortLabel: string;
  readonly shortcut: string | null;
  readonly active: boolean;
  /** Between states, when a press has nothing sensible to do. */
  readonly busy: boolean;
  readonly toggle: () => void;
};

function useMarkMode(): ComposerMode | null {
  const gt = useGT();
  const phase = useMarkModePhase();
  const bridge = getMarkModeBridge();
  if (!bridge) return null;
  return {
    id: "mark",
    icon: PenLineIcon,
    label: gt("Mark Mode"),
    shortLabel: gt("Mark", {
      $context: "short button label for Mark Mode: draw on the screen while talking",
    }),
    shortcut: isMacPlatform(window.desktopBridge?.getClientPlatform() ?? navigator.platform)
      ? "⌥⇧M"
      : "Alt+Shift+M",
    active: phase === "starting" || phase === "recording",
    // The overlay opens during "starting"; "transcribing" fills the draft. Neither can be stopped.
    busy: phase === "starting" || phase === "transcribing",
    toggle: () => {
      if (phase === "recording") finishMarkMode();
      else if (phase === "idle") void startMarkMode();
    },
  };
}

export function useComposerModes(): ReadonlyArray<ComposerMode> {
  const mark = useMarkMode();
  return mark ? [mark] : [];
}
