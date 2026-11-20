import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { userHomeThreadRef } from "@t3tools/client-runtime/state/home";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { msg, useGT, useMessages } from "gt-react-native";
import { Pressable, View } from "react-native";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import type { MessageResolver } from "../../i18n/messages";
import { userHomeAtom } from "../../state/home";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { DONE_STATUS_LABEL, STATUS_LABEL_BY_STATUS } from "../threads/thread-list-v2-items";
import { resolveThreadListV2RowStatus, threadHasUnseenCompletion } from "../threads/threadListV2";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";

const UNREACHABLE_PHASES: ReadonlySet<EnvironmentConnectionPhase> = new Set([
  "offline",
  "reconnecting",
  "error",
  "unsupported",
]);

function homeStatus(thread: EnvironmentThreadShell | undefined, resolve: MessageResolver) {
  if (thread === undefined) return undefined;
  const status = resolveThreadListV2RowStatus(thread);
  const presentation =
    STATUS_LABEL_BY_STATUS[status] ??
    (status === "ready" && threadHasUnseenCompletion(thread) ? DONE_STATUS_LABEL : undefined);
  if (presentation === undefined) return undefined;
  return {
    ...presentation,
    label: resolve(
      presentation.label ??
        (status === "waiting"
          ? msg("Waiting", { $context: "thread status" })
          : msg("Working", { $context: "thread status" })),
    ),
  };
}

/** The user's one Home, pinned above the thread list on whichever environment runs it. */
export function HomeAgentRow(props: {
  readonly thread: EnvironmentThreadShell | undefined;
  readonly environments: ReadonlyArray<
    HomeListFilterMenuEnvironment & Pick<WorkspaceEnvironment, "connectionState">
  >;
  readonly onOpen: (params: { environmentId: string; threadId: string }) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const userHome = useAtomValue(userHomeAtom);
  const { machineByEnvironmentId } = useAtomValue(threadListEnvironmentsAtom);
  const ref = userHomeThreadRef(userHome);
  if (ref === null) return null;
  const environment = props.environments.find(
    (candidate) => candidate.environmentId === ref.environmentId,
  );
  const conflict = userHome.kind === "conflict";
  const place = conflict
    ? gt("On in {count} places", { count: userHome.hosts.length })
    : (environment?.label ?? gt("another environment"));
  const offline =
    !conflict && environment !== undefined && UNREACHABLE_PHASES.has(environment.connectionState);
  const status = offline
    ? {
        label: gt("Offline", { $context: "connection status" }),
        icon: "wifi.slash" as const,
        className: "text-thread-selected-foreground-muted",
        iconTintClassName: "accent-thread-selected-foreground-muted",
      }
    : homeStatus(props.thread, messages);
  const machine = machineByEnvironmentId.get(ref.environmentId);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={["Home", place, status?.label].filter(Boolean).join(", ")}
      onPress={() =>
        props.onOpen({ environmentId: String(ref.environmentId), threadId: String(ref.threadId) })
      }
      className="mx-4 mt-2 gap-1 rounded-xl bg-thread-selected px-3 py-2.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View className="flex-row items-center gap-2.5">
        <SymbolView
          name="house"
          size={16}
          tintColorClassName="accent-thread-selected-foreground"
          type="monochrome"
        />
        <Text className="flex-1 text-sm font-t3-medium text-thread-selected-foreground">Home</Text>
        {status === undefined ? null : (
          <View className="flex-row items-center gap-1">
            <SymbolView
              name={status.icon}
              size={13}
              tintColorClassName={status.iconTintClassName}
              type="monochrome"
              weight="semibold"
            />
            <Text className={cn("text-xs font-t3-bold", status.className)}>{status.label}</Text>
          </View>
        )}
      </View>
      <View className="flex-row items-center gap-1.5">
        <Text
          numberOfLines={1}
          className={cn(
            "flex-1 text-xs",
            conflict ? "text-warning-foreground" : "text-thread-selected-foreground-muted",
          )}
        >
          {place}
        </Text>
        {conflict ? (
          <SymbolView
            name="exclamationmark.triangle"
            size={13}
            tintColorClassName="accent-warning-foreground"
            type="monochrome"
          />
        ) : machine === undefined ? null : (
          <EnvironmentMachineSymbol
            kind={machine}
            size={13}
            tintColorClassName="accent-thread-selected-foreground-muted"
          />
        )}
      </View>
    </Pressable>
  );
}
