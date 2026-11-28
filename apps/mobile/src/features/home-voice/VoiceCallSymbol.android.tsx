import IconMicrophoneOff from "@tabler/icons-react-native/IconMicrophoneOff";
import IconPhoneEnd from "@tabler/icons-react-native/IconPhoneEnd";
import IconVolume from "@tabler/icons-react-native/IconVolume";
import { withUniwind } from "uniwind";

const ICONS = { hangUp: IconPhoneEnd, micOff: IconMicrophoneOff, speaker: IconVolume } as const;

export const VoiceCallSymbol = withUniwind(function VoiceCallSymbol(props: {
  readonly name: keyof typeof ICONS;
  readonly size: number;
  readonly tintColor?: string;
}) {
  const Icon = ICONS[props.name];
  return <Icon size={props.size} color={props.tintColor} strokeWidth={2.25} />;
});
