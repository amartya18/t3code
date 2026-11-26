import IconMicrophoneOff from "@tabler/icons-react-native/IconMicrophoneOff";
import IconPhoneEnd from "@tabler/icons-react-native/IconPhoneEnd";
import { withUniwind } from "uniwind";

const ICONS = { hangUp: IconPhoneEnd, micOff: IconMicrophoneOff } as const;

export const VoiceCallSymbol = withUniwind(function VoiceCallSymbol(props: {
  readonly name: keyof typeof ICONS;
  readonly size: number;
  readonly tintColor?: string;
}) {
  const Icon = ICONS[props.name];
  return <Icon size={props.size} color={props.tintColor} strokeWidth={2.25} />;
});
