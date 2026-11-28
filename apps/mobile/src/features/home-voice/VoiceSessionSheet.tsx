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
import { SliderRow, type SliderRowProps } from "../../components/ui/SliderRow";
import { groupByProvider } from "../../lib/modelOptions";
import { VOICE_TUNING_RANGE, type VoiceTuning } from "./voiceEngine";
import { splitOlderModels, useVoiceModelOptions, withLowEffort } from "./voiceModels";
import { VoiceReasoningRow } from "./VoiceMenuRow";
import {
  KOKORO_VOICES,
  saveVoiceSettings,
  useVoiceModeSettings,
  type KokoroVoiceId,
} from "./voiceSettings";

const VOICE_NAMES: Record<KokoroVoiceId, string> = {
  af_heart: "Heart",
  am_michael: "Michael",
  bf_emma: "Emma",
};

function TuningRow(props: {
  readonly tuning: VoiceTuning;
  readonly setting: keyof VoiceTuning;
  readonly icon: SliderRowProps["icon"];
  readonly label: string;
  readonly step: number;
}) {
  const gt = useGT();
  const [dragged, setDragged] = useState<number | null>(null);
  const { min, max } = VOICE_TUNING_RANGE[props.setting];
  const seconds = props.tuning[props.setting] / 1000;
  return (
    <View className="border-t border-border-subtle">
      <SliderRow
        icon={props.icon}
        label={props.label}
        valueLabel={gt("{seconds} s", { seconds: (dragged ?? seconds).toFixed(2) })}
        min={min / 1000}
        max={max / 1000}
        step={props.step}
        value={seconds}
        onDrag={setDragged}
        onChange={(next) => {
          setDragged(null);
          void saveVoiceSettings({ [props.setting]: Math.round(next * 1000) });
        }}
      />
    </View>
  );
}

/** Opened from the gear in the call and the pill; every change is saved for later sessions. */
export function VoiceSessionSheet() {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const settings = useVoiceModeSettings();
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
        </ListSection>
        {__DEV__ ? (
          <ListSection footer={gt("Developer options. They apply to the live call at once.")}>
            <ListToggleRow
              icon="brain"
              label={gt("Thinking (dev)")}
              value={settings.thinking}
              onValueChange={(thinking) => void saveVoiceSettings({ thinking })}
            />
            <View className="border-t border-border-subtle">
              <ListToggleRow
                icon="bolt.circle"
                label={gt("Kokoro on GPU (dev)")}
                description={gt("Applies from the next call.")}
                value={settings.kokoroGpu}
                onValueChange={(kokoroGpu) => void saveVoiceSettings({ kokoroGpu })}
              />
            </View>
            <TuningRow
              tuning={settings.tuning}
              setting="minSpeechMs"
              icon="mic"
              label={gt("Minimum speech (dev)")}
              step={0.05}
            />
            <TuningRow
              tuning={settings.tuning}
              setting="minSilenceMs"
              icon="pause"
              label={gt("Silence before scoring (dev)")}
              step={0.05}
            />
            <TuningRow
              tuning={settings.tuning}
              setting="turnWaitMs"
              icon="clock"
              label={gt("Wait when not done (dev)")}
              step={0.1}
            />
            <View className="border-t border-border-subtle">
              <ListActionRow
                icon="arrow.uturn.backward"
                label={gt("Reset to defaults")}
                onPress={() =>
                  void saveVoiceSettings({
                    minSpeechMs: undefined,
                    minSilenceMs: undefined,
                    turnWaitMs: undefined,
                  })
                }
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
