import { SymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";

export const VoiceWaveIcon = withUniwind(function VoiceWaveIcon(props: {
  readonly size: number;
  readonly tintColor?: string;
}) {
  return (
    <SymbolView name="waveform" size={props.size} weight="semibold" tintColor={props.tintColor} />
  );
});
