import { useAtomValue } from "@effect/atom-react";
import type { HomeHost } from "@t3tools/client-runtime/state/home";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import { homeEnvironment, userHomeAtom } from "../../state/home";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

function reportFailure(title: string, error: unknown) {
  Alert.alert(title, error instanceof Error ? error.message : "An error occurred.");
}

/** Connected environments that can host Home. Older servers do not report a Home folder. */
function homeCandidates(environments: ReadonlyArray<EnvironmentPresentation>) {
  return environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.homeWorkspaceRoot !== undefined,
  );
}

/** Home on any environment: turn it on or off, start fresh, and open it. Moving lives on desktop and web. */
export function SettingsHomeRouteScreen() {
  const insets = useSafeAreaInsets();
  const userHome = useAtomValue(userHomeAtom);
  return (
    <SettingsScreen title="Home">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {userHome.kind === "off" ? (
          <HomeOff />
        ) : userHome.kind === "on" ? (
          <HomeOn host={userHome} />
        ) : (
          <HomeConflict hosts={userHome.hosts} />
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function useOpenHome() {
  const selectDetail = useSelectWorkspaceDetail();
  return (environmentId: EnvironmentId, threadId: string) =>
    selectDetail({ name: "Thread", params: { environmentId: String(environmentId), threadId } });
}

function HomeOff() {
  const { environments } = useEnvironments();
  const candidates = homeCandidates(environments);
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environmentId =
    candidates.find((candidate) => candidate.environmentId === chosen)?.environmentId ??
    candidates[0]?.environmentId ??
    null;
  return (
    <>
      <SettingsSection
        title="Runs on"
        footer={
          candidates.length === 0
            ? "No connected environment can run Home."
            : "One agent that acts across your projects on the environment it runs on and the environments it links to. Home always runs in full access."
        }
      >
        {candidates.map((candidate, index) => (
          <ListChoiceRow
            key={candidate.environmentId}
            label={candidate.label}
            selected={candidate.environmentId === environmentId}
            separated={index > 0}
            onPress={() => setChosen(candidate.environmentId)}
          />
        ))}
      </SettingsSection>
      {environmentId === null ? null : (
        <HomeTurnOn key={environmentId} environmentId={environmentId} />
      )}
    </>
  );
}

function HomeTurnOn({ environmentId }: { environmentId: EnvironmentId }) {
  const model = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.defaultModelSelection ?? null,
  );
  const enable = useAtomCommand(homeEnvironment.enable, { reportFailure: false });
  const openHome = useOpenHome();
  const [pending, setPending] = useState(false);

  const turnOn = async () => {
    if (model === null) return;
    setPending(true);
    const result = await enable({ environmentId, input: { modelSelection: model } });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not turn on Home", squashAtomCommandFailure(result));
      }
      return;
    }
    openHome(environmentId, result.value.threadId);
  };

  return (
    <SettingsSection
      footer={
        model === null
          ? "This environment has no default model. Set one there, or turn Home on from desktop or web to pick a model."
          : `Starts with ${model.model}, the environment's default model.`
      }
    >
      <SettingsRow
        icon="house"
        label="Turn on Home"
        disabled={pending || model === null}
        onPress={() => void turnOn()}
      />
    </SettingsSection>
  );
}

function HomeOn({ host }: { host: HomeHost }) {
  const { environments } = useEnvironments();
  const label =
    environments.find((environment) => environment.environmentId === host.environmentId)?.label ??
    host.environmentId;
  const startFresh = useAtomCommand(homeEnvironment.startFresh, { reportFailure: false });
  const disable = useAtomCommand(homeEnvironment.disable, { reportFailure: false });
  const openHome = useOpenHome();
  const [pending, setPending] = useState(false);

  const runStartFresh = async () => {
    setPending(true);
    const result = await startFresh({ environmentId: host.environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not start a fresh Home", squashAtomCommandFailure(result));
      }
      return;
    }
    openHome(host.environmentId, result.value.threadId);
  };

  const turnOff = () =>
    Alert.alert("Turn off Home?", "Home stops. Its threads stay.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Turn off",
        style: "destructive",
        onPress: () => {
          setPending(true);
          void disable({ environmentId: host.environmentId, input: {} }).then((result) => {
            setPending(false);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              reportFailure("Could not turn off Home", squashAtomCommandFailure(result));
            }
          });
        },
      },
    ]);

  return (
    <>
      <SettingsSection footer="To move Home to another environment, use Settings → Home on desktop or web. It copies Home's notes along.">
        <SettingsRow
          icon="house"
          label="Open Home"
          value={label}
          onPress={() => openHome(host.environmentId, host.threadId)}
        />
      </SettingsSection>
      <SettingsSection>
        <SettingsRow
          icon="arrow.clockwise"
          label="Start fresh"
          disabled={pending}
          onPress={() => void runStartFresh()}
        />
        <SettingsRow icon="xmark" label="Turn off" disabled={pending} onPress={turnOff} />
      </SettingsSection>
    </>
  );
}

function HomeConflict({ hosts }: { hosts: ReadonlyArray<HomeHost> }) {
  const { environments } = useEnvironments();
  const disable = useAtomCommand(homeEnvironment.disable, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const labelOf = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    environmentId;

  const keep = async (kept: HomeHost) => {
    setPending(true);
    for (const host of hosts) {
      if (host.environmentId === kept.environmentId) continue;
      const result = await disable({ environmentId: host.environmentId, input: {} });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure(
          `Could not turn off Home on ${labelOf(host.environmentId)}`,
          squashAtomCommandFailure(result),
        );
      }
    }
    setPending(false);
  };

  return (
    <SettingsSection
      title="Keep one Home"
      footer="Home is on in more than one place. The others turn off and their threads stay."
    >
      {hosts.map((host) => (
        <SettingsRow
          key={host.environmentId}
          icon="checkmark.circle"
          label={`Keep ${labelOf(host.environmentId)}`}
          disabled={pending}
          onPress={() => void keep(host)}
        />
      ))}
    </SettingsSection>
  );
}
