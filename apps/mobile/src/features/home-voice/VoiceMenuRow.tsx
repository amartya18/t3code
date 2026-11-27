import type { MenuAction } from "@react-native-menu/menu";
import type { ModelSelection } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";

import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import type { ModelOption } from "../../lib/modelOptions";
import { voiceReasoning } from "./voiceModels";
import { saveVoiceSettings } from "./voiceSettings";

export function VoiceMenuRow(props: {
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

export function VoiceReasoningRow(props: {
  readonly model: ModelOption | undefined;
  readonly selection: ModelSelection;
  readonly separated?: boolean;
}) {
  const reasoning = voiceReasoning(props.model, props.selection);
  if (reasoning === null) return null;
  const row = (
    <VoiceMenuRow
      icon="brain"
      label={reasoning.label}
      value={reasoning.choices.find((choice) => choice.id === reasoning.current)?.label ?? ""}
      actions={reasoning.choices.map((choice) => ({
        id: choice.id,
        title: choice.label,
        state: choice.id === reasoning.current ? "on" : "off",
      }))}
      onSelect={(id) => void saveVoiceSettings({ modelSelection: reasoning.select(id) })}
    />
  );
  return props.separated ? <View className="border-t border-border-subtle">{row}</View> : row;
}
