import { useGT } from "gt-react";
import type { PointerEvent } from "react";

import { Toggle } from "../components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useComposerModes } from "./composerModes";

// Keeps the composer's caret where it was, as the dictation button does.
const keepFocus = (event: PointerEvent) => event.preventDefault();

/**
 * Fork-only: one icon toggle per composer mode, beside send. Shows nothing where no mode works.
 * With a second mode, this becomes an icon plus a chevron menu of modes.
 */
export function ComposerModeControl() {
  const gt = useGT();
  const modes = useComposerModes();
  return modes.map((mode) => {
    const Icon = mode.icon;
    return (
      <Tooltip key={mode.id}>
        <TooltipTrigger
          render={
            <Toggle
              variant="ghost"
              size="sm"
              pressed={mode.active}
              onPressedChange={mode.toggle}
              disabled={mode.busy}
              aria-label={mode.label}
              onPointerDown={keepFocus}
            >
              <Icon />
            </Toggle>
          }
        />
        <TooltipPopup side="top">
          {mode.shortcut
            ? gt("{action} ({shortcut})", { action: mode.label, shortcut: mode.shortcut })
            : mode.label}
        </TooltipPopup>
      </Tooltip>
    );
  });
}
