import { useGT } from "gt-react";
import { PenLineIcon } from "lucide-react";

import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../components/CommandPalette.logic";
import {
  finishMarkMode,
  getMarkModeBridge,
  startMarkMode,
  useMarkModePhase,
} from "./markModeSession";

/** Fork-only: "Start Mark Mode", or "Finish Mark Mode" while one is open. */
export function useMarkModeCommandItem(): CommandPaletteActionItem | null {
  const gt = useGT();
  const phase = useMarkModePhase();
  if (!getMarkModeBridge() || phase === "transcribing") return null;
  const active = phase !== "idle";
  return {
    kind: "action",
    value: "action:mark-mode",
    searchTerms: ["mark mode", "draw", "annotate", "ink", "screen", "talk", "voice"],
    title: active ? gt("Finish Mark Mode") : gt("Start Mark Mode"),
    icon: <PenLineIcon className={ITEM_ICON_CLASS} />,
    run: async () => {
      if (active) finishMarkMode();
      else await startMarkMode();
    },
  };
}
