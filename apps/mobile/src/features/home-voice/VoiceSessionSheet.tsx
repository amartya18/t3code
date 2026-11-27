import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { SliderRow } from "../../components/ui/SliderRow";
import { groupByProvider } from "../../lib/modelOptions";
import {
  INTERRUPT_MODES,
  RECOVERY_MODES,
  type InterruptMode,
  type RecoveryMode,
} from "./speechQueue";
import { splitOlderModels, useVoiceModelOptions, withLowEffort } from "./voiceModels";
import { VoiceMenuRow, VoiceReasoningRow } from "./VoiceMenuRow";
import {
  KOKORO_VOICES,
  PAUSE_MAX_MS,
  PAUSE_MIN_MS,
  saveVoiceSettings,
  SMART_CUTOFF_MAX_MS,
  SMART_CUTOFF_MIN_MS,
  useVoiceModeSettings,
  type KokoroVoiceId,
} from "./voiceSettings";

const VOICE_NAMES: Record<KokoroVoiceId, string> = {
  af_heart: "Heart",
  am_michael: "Michael",
  bf_emma: "Emma",
};

/** Opened from the gear in the call and the pill; every change is saved for later sessions. */
export function VoiceSessionSheet() {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const settings = useVoiceModeSettings();
  const [draggedPause, setDraggedPause] = useState<number | null>(null);
  const [draggedCutoff, setDraggedCutoff] = useState<number | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const { options, selected } = useVoiceModelOptions(settings, settings?.environmentId ?? null);
  const close = () => navigation.goBack();
  const title = gt("Session settings");
  const { current, older } = splitOlderModels(
    groupByProvider(options).find((group) =>
      group.models.some((option) => option.key === selected?.key),
    )?.models ?? options,
    selected?.key,
  );
  const models = showOlder ? [...current, ...older] : current;
  const interruptNames: Record<InterruptMode, string> = {
    anySound: gt("Any sound"),
    words: gt("Words"),
    hybrid: gt("Duck, then words"),
  };
  const recoveryNames: Record<RecoveryMode, string> = {
    resume: gt("Resume"),
    restart: gt("Restart chunk"),
    smart: gt("Smart"),
  };

  const content =
    settings === null ? null : (
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerClassName="gap-5 px-4 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
      >
        <View className="gap-2">
          <Text textRole="footnote" className="px-2 font-t3-medium text-foreground-muted">
            {gt("Voice · {engine}", { engine: "Kokoro" })}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {KOKORO_VOICES.map((voiceId) => (
              <Chip
                key={voiceId}
                icon="play"
                label={VOICE_NAMES[voiceId]}
                selected={voiceId === settings.voiceId}
                onPress={() => void saveVoiceSettings({ voiceId })}
              />
            ))}
          </View>
        </View>
        <ListSection>
          <SliderRow
            icon="timer"
            label={gt("Pause before sending")}
            valueLabel={gt("{seconds} s", {
              seconds: (draggedPause ?? settings.pauseMs / 1000).toFixed(1),
            })}
            min={PAUSE_MIN_MS / 1000}
            max={PAUSE_MAX_MS / 1000}
            step={0.5}
            value={settings.pauseMs / 1000}
            onDrag={setDraggedPause}
            onChange={(seconds) => {
              setDraggedPause(null);
              void saveVoiceSettings({ pauseMs: Math.round(seconds * 1000) });
            }}
          />
        </ListSection>
        <ListSection footer={gt("Kept for your next sessions.")}>
          {models.map((option, index) => (
            <ListChoiceRow
              key={option.key}
              label={option.label}
              selected={option.key === selected?.key}
              separated={index > 0}
              onPress={() => void saveVoiceSettings({ modelSelection: withLowEffort(option) })}
            />
          ))}
          {older.length === 0 ? null : (
            <View className="border-t border-border-subtle">
              <ListActionRow
                label={showOlder ? gt("Hide older models") : gt("Show older models")}
                onPress={() => setShowOlder(!showOlder)}
              />
            </View>
          )}
          <VoiceReasoningRow model={selected} selection={settings.modelSelection} separated />
          <View className="border-t border-border-subtle">
            <ListToggleRow
              icon={{ ios: "bolt", android: "bolt" }}
              label={gt("Send early when I sound done")}
              value={settings.earlySend}
              onValueChange={(earlySend) => void saveVoiceSettings({ earlySend })}
            />
          </View>
        </ListSection>
        {__DEV__ ? (
          <ListSection footer={gt("Developer options. They apply to the live call at once.")}>
            <VoiceMenuRow
              icon="flask"
              label={gt("Interrupt (dev)")}
              value={interruptNames[settings.interruptMode]}
              actions={INTERRUPT_MODES.map((mode) => ({
                id: mode,
                title: interruptNames[mode],
                state: mode === settings.interruptMode ? "on" : "off",
              }))}
              onSelect={(id) => {
                const interruptMode = INTERRUPT_MODES.find((mode) => mode === id);
                if (interruptMode !== undefined) void saveVoiceSettings({ interruptMode });
              }}
            />
            <View className="border-t border-border-subtle">
              <VoiceMenuRow
                icon="arrow.clockwise"
                label={gt("False alarm (dev)")}
                value={recoveryNames[settings.recovery]}
                actions={RECOVERY_MODES.map((recovery) => ({
                  id: recovery,
                  title: recoveryNames[recovery],
                  state: recovery === settings.recovery ? "on" : "off",
                }))}
                onSelect={(id) => {
                  const recovery = RECOVERY_MODES.find((mode) => mode === id);
                  if (recovery !== undefined) void saveVoiceSettings({ recovery });
                }}
              />
            </View>
            {settings.recovery === "smart" ? (
              <View className="border-t border-border-subtle">
                <SliderRow
                  icon="timer"
                  label={gt("Restart after a pause of (dev)")}
                  valueLabel={gt("{seconds} s", {
                    seconds: (draggedCutoff ?? settings.smartCutoffMs / 1000).toFixed(2),
                  })}
                  min={SMART_CUTOFF_MIN_MS / 1000}
                  max={SMART_CUTOFF_MAX_MS / 1000}
                  step={0.25}
                  value={settings.smartCutoffMs / 1000}
                  onDrag={setDraggedCutoff}
                  onChange={(seconds) => {
                    setDraggedCutoff(null);
                    void saveVoiceSettings({ smartCutoffMs: Math.round(seconds * 1000) });
                  }}
                />
              </View>
            ) : null}
            <View className="border-t border-border-subtle">
              <ListToggleRow
                icon="brain"
                label={gt("Thinking (dev)")}
                value={settings.thinking}
                onValueChange={(thinking) => void saveVoiceSettings({ thinking })}
              />
            </View>
          </ListSection>
        ) : null}
      </ScrollView>
    );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader presentation="native" title={title} onClose={close} />
        {content}
      </View>
    );
  }
  return (
    <View collapsable={false} className="flex-1 bg-header">
      <AppBar sheet title={title} hideBottomBorder onBack={close} />
      {content}
    </View>
  );
}
