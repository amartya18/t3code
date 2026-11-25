import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { userHomeThreadRef } from "@t3tools/client-runtime/state/home";
import type { ModelSelection } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import type { ComponentProps } from "react";
import { Pressable } from "react-native";

import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { buildModelOptions, groupByProvider, type ModelOption } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { userHomeAtom } from "../../state/home";
import { SettingsSection } from "../settings/components/SettingsSection";
import { saveVoiceSettings, useVoiceModeSettings } from "./voiceSettings";

// Voice replies should start fast, so a pick keeps low effort wherever the model offers it.
function withLowEffort(option: ModelOption): ModelSelection {
  const offersLow = option.capabilities?.optionDescriptors?.some(
    (descriptor) =>
      descriptor.id === "effort" &&
      descriptor.type === "select" &&
      descriptor.options.some((choice) => choice.id === "low"),
  );
  const { options: _options, ...selection } = option.selection;
  return offersLow ? { ...selection, options: [{ id: "effort", value: "low" }] } : selection;
}

function MenuRow(props: {
  readonly icon: ComponentProps<typeof ListRowLayout>["icon"];
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
}) {
  const row = <ListRowLayout icon={props.icon} label={props.label} detail={props.value} />;
  if (props.actions.length === 0) return row;
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        className="active:opacity-70"
      >
        {row}
      </Pressable>
    </Menu>
  );
}

/** Fork: the project and model a voice session starts with, on this device. */
export function HomeVoiceSettingsSection() {
  const gt = useGT();
  const settings = useVoiceModeSettings();
  const home = userHomeThreadRef(useAtomValue(userHomeAtom));
  const environmentId = settings?.environmentId ?? home?.environmentId ?? null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const config = useEnvironmentServerConfig(environmentId);
  const modelOptions = buildModelOptions(
    config,
    settings?.modelSelection ?? null,
    undefined,
    settings?.projectId ?? null,
  ).filter((option) => !option.isUnavailable);
  const project = projects.find((candidate) => candidate.id === settings?.projectId);
  const model = modelOptions.find(
    (option) =>
      option.selection.instanceId === settings?.modelSelection.instanceId &&
      option.selection.model === settings.modelSelection.model,
  );

  return (
    <SettingsSection
      title={gt("Voice mode")}
      footer={gt("Starts from the voice button in Home's chat. Saved on this device.")}
    >
      <MenuRow
        icon="folder"
        label={gt("Project")}
        value={project?.title ?? gt("None found")}
        actions={projects.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          state: candidate.id === project?.id ? "on" : "off",
        }))}
        onSelect={(id) => {
          const picked = projects.find((candidate) => candidate.id === id);
          if (picked) {
            void saveVoiceSettings({ environmentId: picked.environmentId, projectId: picked.id });
          }
        }}
      />
      <MenuRow
        icon="cube"
        label={gt("Model")}
        value={model?.label ?? settings?.modelSelection.model ?? gt("Default")}
        actions={groupByProvider(modelOptions).map((group) => ({
          id: group.providerKey,
          title: group.providerLabel,
          subactions: group.models.map((option) => ({
            id: option.key,
            title: option.label,
            state: option.key === model?.key ? "on" : "off",
          })),
        }))}
        onSelect={(key) => {
          const picked = modelOptions.find((option) => option.key === key);
          if (picked) void saveVoiceSettings({ modelSelection: withLowEffort(picked) });
        }}
      />
    </SettingsSection>
  );
}
