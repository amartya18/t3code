import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { SliderRow } from "../../components/ui/SliderRow";
import { groupByProvider } from "../../lib/modelOptions";
import { useVoiceModelOptions, withLowEffort } from "./voiceModels";
import {
  KOKORO_VOICES,
  PAUSE_MAX_MS,
  PAUSE_MIN_MS,
  saveVoiceSettings,
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
  const { options, selected } = useVoiceModelOptions(settings, settings?.environmentId ?? null);
  const close = () => navigation.goBack();
  const title = gt("Session settings");
  const models =
    groupByProvider(options).find((group) =>
      group.models.some((option) => option.key === selected?.key),
    )?.models ?? options;
  const effort = settings?.modelSelection.options?.find((option) => option.id === "effort")?.value;

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
              label={
                option.key === selected?.key && typeof effort === "string"
                  ? `${option.label} · ${effort}`
                  : option.label
              }
              selected={option.key === selected?.key}
              separated={index > 0}
              onPress={() => void saveVoiceSettings({ modelSelection: withLowEffort(option) })}
            />
          ))}
          <View className="border-t border-border-subtle">
            <ListToggleRow
              icon={{ ios: "bolt", android: "bolt" }}
              label={gt("Send early when I sound done")}
              value={settings.earlySend}
              onValueChange={(earlySend) => void saveVoiceSettings({ earlySend })}
            />
          </View>
        </ListSection>
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
