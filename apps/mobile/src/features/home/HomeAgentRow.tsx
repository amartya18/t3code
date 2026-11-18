import { useAtomValue } from "@effect/atom-react";
import { userHomeThreadRef } from "@t3tools/client-runtime/state/home";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { userHomeAtom } from "../../state/home";

/** The user's one Home, pinned above the thread list on whichever environment runs it. */
export function HomeAgentRow(props: {
  readonly onOpen: (params: { environmentId: string; threadId: string }) => void;
}) {
  const userHome = useAtomValue(userHomeAtom);
  const { environments } = useEnvironments();
  const ref = userHomeThreadRef(userHome);
  if (ref === null) return null;
  const place =
    userHome.kind === "conflict"
      ? "On in 2 places"
      : (environments.find((environment) => environment.environmentId === ref.environmentId)
          ?.label ?? null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={place === null ? "Home" : `Home, ${place}`}
      onPress={() =>
        props.onOpen({ environmentId: String(ref.environmentId), threadId: String(ref.threadId) })
      }
      className="mx-4 mt-2 flex-row items-center gap-3 rounded-lg border border-border px-3 py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView name="house" size={16} tintColorClassName="accent-foreground" type="monochrome" />
      <Text className="flex-1 text-sm font-t3-medium text-foreground">Home</Text>
      {place === null ? null : (
        <View className="max-w-[55%]">
          <Text
            numberOfLines={1}
            className={
              userHome.kind === "conflict"
                ? "text-xs text-warning-foreground"
                : "text-xs text-foreground-muted"
            }
          >
            {place}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
