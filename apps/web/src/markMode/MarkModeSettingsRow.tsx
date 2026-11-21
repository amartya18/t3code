import { useGT } from "gt-react";

import { isElectron } from "../env";
import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { SettingsRow } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../components/ui/number-field";

/** Fork-only: how long a drawing pause must last to end a Mark Mode mark. */
export function MarkModeSettingsRow() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const pauseMs = useClientSettings((settings) => settings.markModePauseMs);
  if (!isElectron) return null;
  return (
    <SettingsRow
      {...setting("mark-mode-pause")}
      title={gt("Mark Mode pause")}
      description={gt("A pause this long with no drawing ends a mark.")}
      control={
        <NumberField
          key={pauseMs}
          defaultValue={pauseMs / 1_000}
          min={0.3}
          max={10}
          step={0.1}
          format={{ maximumFractionDigits: 1 }}
          size="sm"
          className="w-auto"
          onValueCommitted={(seconds) => {
            if (seconds === null) return;
            const next = Math.round(Math.min(Math.max(seconds, 0.3), 10) * 1_000);
            if (next !== pauseMs) void updateClientSettings({ markModePauseMs: next });
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={gt("Shorter Mark Mode pause")} />
            <NumberFieldInput
              aria-label={gt("Mark Mode pause in seconds")}
              size={4}
              className="w-auto grow-0 text-right"
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {gt("sec", { $context: "abbreviation for seconds, shown after a number" })}
            </span>
            <NumberFieldIncrement aria-label={gt("Longer Mark Mode pause")} />
          </NumberFieldGroup>
        </NumberField>
      }
    />
  );
}
