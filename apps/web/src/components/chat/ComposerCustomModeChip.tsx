import { XIcon } from "lucide-react";
import { memo } from "react";

import { isMacPlatform } from "~/lib/utils";
import { ContextChip, ContextChipAction, ContextChipLabel } from "../ContextChip";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ComposerCustomModeChip = memo(function ComposerCustomModeChip(props: {
  skill: string;
  onTurnOff: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<ContextChip kind="skill" data-composer-custom-mode={props.skill} />}>
        <ContextChipLabel>{props.skill}</ContextChipLabel>
        <ContextChipAction
          aria-label={`Turn off custom mode ${props.skill}`}
          onClick={props.onTurnOff}
        >
          <XIcon aria-hidden="true" />
        </ContextChipAction>
      </TooltipTrigger>
      <TooltipPopup side="top">Custom mode: every message follows {props.skill}.</TooltipPopup>
    </Tooltip>
  );
});

/** Shown on the highlighted skill row of the composer's skill menu. */
export function ComposerCustomModeMenuHint() {
  return (
    <span className="flex shrink-0 items-center gap-1 text-secondary-label text-xs">
      <Kbd>{isMacPlatform(navigator.platform) ? "⌥⏎" : "Alt+⏎"}</Kbd>
      use as mode
    </span>
  );
}
