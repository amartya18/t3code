import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { userHomeThreadRef } from "@t3tools/client-runtime/state/home";
import { useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { Pressable } from "react-native";

import { voiceEngine } from "../../../modules/t3-voice-mode";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { formatBytes } from "../../lib/formatBytes";
import { groupByProvider, type ModelOption } from "../../lib/modelOptions";
import { useProjects } from "../../state/entities";
import { userHomeAtom } from "../../state/home";
import { SettingsSection } from "../settings/components/SettingsSection";
import { voiceEngineConfig } from "./voiceEngine";
import { splitOlderModels, useVoiceModelOptions, withLowEffort } from "./voiceModels";
import { VoiceMenuRow, VoiceReasoningRow } from "./VoiceMenuRow";
import { voiceSessionAtom } from "./voiceSession";
import { DEFAULT_MIN_SPEECH_MS, saveVoiceSettings, useVoiceModeSettings } from "./voiceSettings";

/** Fork: the project and model a voice session starts with, on this device. */
export function HomeVoiceSettingsSection() {
  const gt = useGT();
  const settings = useVoiceModeSettings();
  const home = userHomeThreadRef(useAtomValue(userHomeAtom));
  const environmentId = settings?.environmentId ?? home?.environmentId ?? null;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const { options: modelOptions, selected: model } = useVoiceModelOptions(settings, environmentId);
  const project = projects.find((candidate) => candidate.id === settings?.projectId);

  return (
    <SettingsSection
      title={gt("Voice mode")}
      footer={gt("Starts from the voice button in Home's chat. Saved on this device.")}
    >
      <VoiceMenuRow
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
      <VoiceMenuRow
        icon="cube"
        label={gt("Model")}
        value={model?.label ?? settings?.modelSelection.model ?? gt("Default")}
        actions={groupByProvider(modelOptions).map((group) => {
          const { current, older } = splitOlderModels(group.models, model?.key);
          const modelAction = (option: ModelOption): MenuAction => ({
            id: option.key,
            title: option.label,
            state: option.key === model?.key ? "on" : "off",
          });
          return {
            id: group.providerKey,
            title: group.providerLabel,
            subactions: [
              ...current.map(modelAction),
              ...(older.length === 0
                ? []
                : [
                    {
                      id: `${group.providerKey}:older`,
                      title: gt("Older models"),
                      subactions: older.map(modelAction),
                    },
                  ]),
            ],
          };
        })}
        onSelect={(key) => {
          const picked = modelOptions.find((option) => option.key === key);
          if (picked) void saveVoiceSettings({ modelSelection: withLowEffort(picked) });
        }}
      />
      {settings === null ? null : (
        <VoiceReasoningRow model={model} selection={settings.modelSelection} />
      )}
      {voiceEngine === null ? null : (
        <VoiceDownloadRow
          voiceId={settings?.voiceId ?? "af_heart"}
          minSpeechMs={settings?.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS}
        />
      )}
    </SettingsSection>
  );
}

/** The on-device speech models: their size on disk, and a way to free it. */
function VoiceDownloadRow(props: { readonly voiceId: string; readonly minSpeechMs: number }) {
  const gt = useGT();
  const sessionLive = useAtomValue(voiceSessionAtom) !== null;
  const [bytes, setBytes] = useState<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the models live on disk, measured by the native engine
  useEffect(() => {
    if (voiceEngine === null) return;
    const engine = voiceEngine;
    let current = true;
    void engine
      .configure(voiceEngineConfig(props.voiceId, props.minSpeechMs))
      .then(() => engine.modelStatus())
      .then((status) => {
        if (current) setBytes(status.bytesOnDisk);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [props.voiceId, props.minSpeechMs]);

  const label = gt("Voice download");
  const size = bytes === null ? "" : bytes === 0 ? gt("None") : formatBytes(bytes);
  const remove = () => {
    if (sessionLive) {
      Dialog.alert(gt("End the voice session first"), gt("The voice is in use."));
      return;
    }
    Dialog.confirm({
      title: gt("Delete the voice download?"),
      message: gt("Your next voice session downloads it again, about 320 MB."),
      confirmText: gt("Delete"),
      destructive: true,
      onConfirm: () => {
        void voiceEngine?.deleteModels().then(
          () => setBytes(0),
          () => Dialog.alert(gt("Couldn't delete the voice download")),
        );
      },
    });
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${size}`}
      accessibilityHint={gt("Deletes the voice download")}
      disabled={bytes === null || bytes === 0}
      onPress={remove}
      className="active:opacity-70"
    >
      <ListRowLayout
        icon="arrow.down.circle"
        label={label}
        detail={size}
        accessory={
          bytes === null || bytes === 0 ? undefined : (
            <SymbolView
              name="trash"
              size={16}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          )
        }
      />
    </Pressable>
  );
}
