import { selectableProviderOptionChoices } from "@t3tools/client-runtime/model-traits";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";

import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";
import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { isVoiceInstance } from "./voiceInstances";
import type { VoiceModeSettings } from "./voiceSettings";

// Like the composer, the first select option is the model's reasoning control.
export function voiceReasoning(option: ModelOption | undefined, selection: ModelSelection) {
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: option?.capabilities,
    selections: selection.options,
  });
  const descriptor = descriptors.find((candidate) => candidate.type === "select");
  if (descriptor?.type !== "select") return null;
  return {
    label: descriptor.label,
    current: getProviderOptionCurrentValue(descriptor, selection),
    choices: selectableProviderOptionChoices(descriptor),
    select: (value: string): ModelSelection => ({
      ...selection,
      options: applyProviderOptionSelection(descriptors, { id: descriptor.id, value }) ?? [],
    }),
  };
}

// Voice replies should start fast, so a pick keeps low effort wherever the model offers it.
export function withLowEffort(option: ModelOption): ModelSelection {
  const { options: _options, ...selection } = option.selection;
  const reasoning = voiceReasoning(option, selection);
  return reasoning?.choices.some((choice) => choice.id === "low")
    ? reasoning.select("low")
    : selection;
}

export function splitOlderModels(options: ReadonlyArray<ModelOption>, selectedKey?: string) {
  const current: ModelOption[] = [];
  const older: ModelOption[] = [];
  for (const option of options) {
    (option.isLegacy && option.key !== selectedKey ? older : current).push(option);
  }
  return { current, older };
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
  ).filter((option) => !option.isUnavailable && !isVoiceInstance(option.selection.instanceId));
  const selected = options.find(
    (option) =>
      option.selection.instanceId === settings?.modelSelection.instanceId &&
      option.selection.model === settings.modelSelection.model,
  );
  return { options, selected };
}
