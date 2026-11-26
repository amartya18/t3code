import { SymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";

const SF_SYMBOLS = { hangUp: "phone.down.fill", micOff: "mic.slash.fill" } as const;

export const VoiceCallSymbol = withUniwind(function VoiceCallSymbol(props: {
  readonly name: keyof typeof SF_SYMBOLS;
  readonly size: number;
  readonly tintColor?: string;
}) {
  return <SymbolView name={SF_SYMBOLS[props.name]} size={props.size} tintColor={props.tintColor} />;
});
