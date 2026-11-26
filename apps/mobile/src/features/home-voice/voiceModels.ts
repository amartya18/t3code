import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";

import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import type { VoiceModeSettings } from "./voiceSettings";

// Voice replies should start fast, so a pick keeps low effort wherever the model offers it.
export function withLowEffort(option: ModelOption): ModelSelection {
  const offersLow = option.capabilities?.optionDescriptors?.some(
    (descriptor) =>
      descriptor.id === "effort" &&
      descriptor.type === "select" &&
      descriptor.options.some((choice) => choice.id === "low"),
  );
  const { options: _options, ...selection } = option.selection;
  return offersLow ? { ...selection, options: [{ id: "effort", value: "low" }] } : selection;
}

/** The models a voice session can run on, and the one it uses now. */
export function useVoiceModelOptions(
  settings: VoiceModeSettings | null,
  environmentId: EnvironmentId | null,
) {
  const config = useEnvironmentServerConfig(environmentId);
  const options = buildModelOptions(
    config,
    settings?.modelSelection ?? null,
    undefined,
    settings?.projectId ?? null,
  ).filter((option) => !option.isUnavailable);
  const selected = options.find(
    (option) =>
      option.selection.instanceId === settings?.modelSelection.instanceId &&
      option.selection.model === settings.modelSelection.model,
  );
  return { options, selected };
}
