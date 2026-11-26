import IconWaveSine from "@tabler/icons-react-native/IconWaveSine";
import { withUniwind } from "uniwind";

export const VoiceWaveIcon = withUniwind(function VoiceWaveIcon(props: {
  readonly size: number;
  readonly tintColor?: string;
}) {
  return <IconWaveSine size={props.size} color={props.tintColor} strokeWidth={2.25} />;
});
