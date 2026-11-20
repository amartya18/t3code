import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { HomeHost } from "@t3tools/client-runtime/state/home";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ModelSelection, ServerProvider, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { T, Var, msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  providerInstanceEntriesFor,
} from "../../providerInstances";
import { useThreadShell } from "../../state/entities";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { homeEnvironment, userHomeAtom } from "../../state/home";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const HOME_DESCRIPTION = msg(
  "One agent that acts across your projects on the environment it runs on and the environments it links to. It can answer questions and approve requests for you there.",
);

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** Settings page for Home: where it runs, its model, and the rare actions that change it. */
export function HomeSettings() {
  const userHome = useAtomValue(userHomeAtom);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Home">
        {userHome.kind === "off" ? (
          <HomeOffRows />
        ) : userHome.kind === "on" ? (
          <HomeOnRows host={userHome} />
        ) : (
          <HomeConflictRows hosts={userHome.hosts} />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function reportHomeFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : m(msg("An error occurred.")),
  });
}

function useNavigateToThread() {
  const navigate = useNavigate();
  return (environmentId: EnvironmentId, threadId: ThreadId) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
}

/** Connected environments that can host Home. Older servers do not report a Home folder. */
function useHomeCandidates(): ReadonlyArray<EnvironmentPresentation> {
  const { environments } = useEnvironments();
  return environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.homeWorkspaceRoot !== undefined,
  );
}

/** The model Home starts with on an environment: the user's pick, else that environment's default. */
function useHomeModel(environmentId: EnvironmentId) {
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_PROVIDERS;
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const usable = (instanceId: string) =>
    entries.some(
      (entry) => entry.instanceId === instanceId && isProviderInstancePickerReady(entry),
    );
  const fallbackEntry = entries.find(isProviderInstancePickerReady);
  const fallbackModel = fallbackEntry
    ? resolveAppModelSelectionForInstance(fallbackEntry.instanceId, settings, providers, null)
    : null;
  const selection =
    picked !== null && usable(picked.instanceId)
      ? picked
      : settings.defaultModelSelection && usable(settings.defaultModelSelection.instanceId)
        ? settings.defaultModelSelection
        : fallbackEntry && fallbackModel
          ? createModelSelection(fallbackEntry.instanceId, fallbackModel)
          : null;
  const picker =
    selection === null ? (
      <span className="text-sm text-muted-foreground">{gt("No providers available.")}</span>
    ) : (
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={getCustomModelOptionsByInstance(
          settings,
          providers,
          selection.instanceId,
          selection.model,
        )}
        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
        onInstanceModelChange={(instanceId, model) =>
          setPicked(createModelSelection(instanceId, model))
        }
      />
    );
  return { selection, picker };
}

function EnvironmentSelect(props: {
  candidates: ReadonlyArray<EnvironmentPresentation>;
  value: EnvironmentId | null;
  onChange: (environmentId: EnvironmentId) => void;
  disabled?: boolean;
}) {
  const gt = useGT();
  const current = props.candidates.find((candidate) => candidate.environmentId === props.value);
  return (
    <Select
      value={props.value ?? ""}
      onValueChange={(value) => {
        if (value) props.onChange(value as EnvironmentId);
      }}
      disabled={props.disabled === true || props.candidates.length === 0}
    >
      <SelectTrigger size="compact" className="w-48" aria-label={gt("Environment")}>
        <SelectValue>{current?.label ?? gt("Choose an environment")}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.candidates.map((candidate) => (
          <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
            {candidate.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function HomeOffRows() {
  const gt = useGT();
  const messages = useMessages();
  const searchableSetting = useSearchableSetting();
  const candidates = useHomeCandidates();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environmentId =
    candidates.find((candidate) => candidate.environmentId === chosen)?.environmentId ??
    candidates.find((candidate) => candidate.environmentId === primaryEnvironmentId)
      ?.environmentId ??
    candidates[0]?.environmentId ??
    null;
  return (
    <>
      <SettingsRow
        {...searchableSetting("home")}
        description={messages(HOME_DESCRIPTION)}
        control={
          candidates.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              {gt("No environment can run Home.")}
            </span>
          ) : null
        }
      />
      {environmentId === null ? null : (
        <>
          <SettingsRow
            title={gt("Runs on")}
            description={gt(
              "The environment that hosts Home. Keep it running so Home stays reachable.",
            )}
            control={
              <EnvironmentSelect
                candidates={candidates}
                value={environmentId}
                onChange={setChosen}
              />
            }
          />
          <HomeTurnOnRow key={environmentId} environmentId={environmentId} />
        </>
      )}
    </>
  );
}

function HomeTurnOnRow({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const { selection, picker } = useHomeModel(environmentId);
  const enable = useAtomCommand(homeEnvironment.enable, { reportFailure: false });
  const navigateToThread = useNavigateToThread();
  const [pending, setPending] = useState(false);

  const turnOn = async () => {
    if (selection === null) return;
    setPending(true);
    const result = await enable({ environmentId, input: { modelSelection: selection } });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportHomeFailure(m(msg("Could not turn on Home")), squashAtomCommandFailure(result));
      }
      return;
    }
    await navigateToThread(environmentId, result.value.threadId);
  };

  return (
    <SettingsRow
      title={gt("Model")}
      description={gt("Home always runs in full access. Choose a model you trust with that.")}
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {picker}
          <Button size="sm" disabled={pending || selection === null} onClick={() => void turnOn()}>
            <T>Turn on Home</T>
          </Button>
        </div>
      }
    />
  );
}

function HomeOnRows({ host }: { host: HomeHost }) {
  const gt = useGT();
  const messages = useMessages();
  const searchableSetting = useSearchableSetting();
  const { environmentId, threadId } = host;
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const candidates = useHomeCandidates();
  const { environments } = useEnvironments();
  const hostEnvironment = environments.find(
    (environment) => environment.environmentId === environmentId,
  );
  const hostConnected = hostEnvironment?.connection.phase === "connected";
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_PROVIDERS;
  const startFresh = useAtomCommand(homeEnvironment.startFresh, { reportFailure: false });
  const disable = useAtomCommand(homeEnvironment.disable, { reportFailure: false });
  const openInEditor = useOpenInPreferredEditor(environmentId, config?.availableEditors ?? []);
  const navigateToThread = useNavigateToThread();
  const [pending, setPending] = useState(false);
  const [moveTarget, setMoveTarget] = useState<EnvironmentId | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);

  const moveCandidates = candidates.filter(
    (candidate) => candidate.environmentId !== environmentId,
  );
  const target =
    moveCandidates.find((candidate) => candidate.environmentId === moveTarget) ??
    moveCandidates[0] ??
    null;

  const modelSelection = thread?.modelSelection ?? null;
  const modelEntry = modelSelection
    ? deriveProviderInstanceEntries(providers).find(
        (entry) => entry.instanceId === modelSelection.instanceId,
      )
    : undefined;
  const model = modelEntry?.models.find((option) => option.slug === modelSelection?.model);
  const modelLabel =
    modelSelection === null
      ? null
      : model
        ? getTriggerDisplayModelName(model, modelEntry?.driverKind)
        : modelSelection.model;
  const homeWorkspaceRoot = config?.homeWorkspaceRoot ?? null;
  const instructionsPath =
    homeWorkspaceRoot === null
      ? null
      : `${homeWorkspaceRoot.replace(/[\\/]+$/, "")}${
          homeWorkspaceRoot.includes("\\") && !homeWorkspaceRoot.includes("/") ? "\\" : "/"
        }AGENTS.md`;

  const runStartFresh = async () => {
    setPending(true);
    const result = await startFresh({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportHomeFailure(m(msg("Could not start a fresh Home")), squashAtomCommandFailure(result));
      }
      return;
    }
    await navigateToThread(environmentId, result.value.threadId);
  };

  const turnOff = async () => {
    setPending(true);
    const result = await disable({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportHomeFailure(m(msg("Could not turn off Home")), squashAtomCommandFailure(result));
    }
  };

  const editInstructions = async () => {
    if (instructionsPath === null) return;
    const result = await openInEditor(instructionsPath);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportHomeFailure(m(msg("Could not open instructions")), squashAtomCommandFailure(result));
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("home")}
        description={messages(HOME_DESCRIPTION)}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigateToThread(environmentId, threadId)}
          >
            <T>Open Home</T>
          </Button>
        }
      />
      <SettingsRow
        title={gt("Runs on")}
        description={
          hostConnected
            ? gt(
                "{environment}. Moving starts a new Home there and copies its notes and instructions.",
                {
                  environment: hostEnvironment?.label ?? gt("This environment"),
                },
              )
            : gt("{environment} is offline. Home can move once it is back.", {
                environment: hostEnvironment?.label ?? gt("Its environment"),
              })
        }
        control={
          moveCandidates.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              {hostEnvironment?.label ?? environmentId}
            </span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <EnvironmentSelect
                candidates={moveCandidates}
                value={target?.environmentId ?? null}
                onChange={setMoveTarget}
                disabled={!hostConnected || pending}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!hostConnected || pending || target === null}
                onClick={() => setMoveOpen(true)}
              >
                <T>Move</T>
              </Button>
            </div>
          )
        }
      />
      {modelLabel === null ? null : (
        <SettingsRow
          title={gt("Model")}
          control={<span className="text-sm text-muted-foreground">{modelLabel}</span>}
        />
      )}
      <SettingsRow
        title={gt("Start fresh")}
        description={gt("Clears Home's memory of this chat. The history stays visible.")}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void runStartFresh()}
          >
            <T>Start fresh</T>
          </Button>
        }
      />
      {instructionsPath === null ? null : (
        <SettingsRow
          title={gt("Instructions")}
          description={
            environmentId === primaryEnvironmentId
              ? gt("AGENTS.md in the Home folder.")
              : gt("AGENTS.md in the Home folder on {environment}: {path}", {
                  environment: hostEnvironment?.label ?? gt("its environment"),
                  path: instructionsPath,
                })
          }
          control={
            environmentId === primaryEnvironmentId ? (
              <Button size="sm" variant="outline" onClick={() => void editInstructions()}>
                <T>Edit</T>
              </Button>
            ) : null
          }
        />
      )}
      <SettingsRow
        title={gt("Turn off")}
        description={gt("Home stops. Its threads stay.")}
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={pending}
            onClick={() => void turnOff()}
          >
            <T>Turn off</T>
          </Button>
        }
      />
      {target === null ? null : (
        <MoveHomeDialog
          open={moveOpen}
          onOpenChange={setMoveOpen}
          from={host}
          fromLabel={hostEnvironment?.label ?? environmentId}
          fromRoot={homeWorkspaceRoot}
          to={target}
        />
      )}
    </>
  );
}

function MoveHomeDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from: HomeHost;
  fromLabel: string;
  fromRoot: string | null;
  to: EnvironmentPresentation;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <MoveHomeDialogPopup key={props.to.environmentId} {...props} /> : null}
    </AlertDialog>
  );
}

function MoveHomeDialogPopup(props: {
  onOpenChange: (open: boolean) => void;
  from: HomeHost;
  fromLabel: string;
  fromRoot: string | null;
  to: EnvironmentPresentation;
}) {
  const { from, to } = props;
  const { selection, picker } = useHomeModel(to.environmentId);
  const toRoot = to.serverConfig?.homeWorkspaceRoot ?? null;
  const readFolder = useAtomCommand(homeEnvironment.readFolder, { reportFailure: false });
  const writeFolder = useAtomCommand(homeEnvironment.writeFolder, { reportFailure: false });
  const disable = useAtomCommand(homeEnvironment.disable, { reportFailure: false });
  const enable = useAtomCommand(homeEnvironment.enable, { reportFailure: false });
  const navigateToThread = useNavigateToThread();
  const [busy, setBusy] = useState(false);

  // Off first, then on: a failure leaves Home off, never on in two places.
  const move = async () => {
    if (selection === null || toRoot === null) return;
    setBusy(true);
    const snapshot =
      props.fromRoot === null
        ? null
        : await readFolder({ environmentId: from.environmentId, input: { cwd: props.fromRoot } });
    if (snapshot?._tag === "Failure") {
      setBusy(false);
      reportHomeFailure(m(msg("Could not read Home's notes")), squashAtomCommandFailure(snapshot));
      return;
    }
    const off = await disable({ environmentId: from.environmentId, input: {} });
    if (off._tag === "Failure") {
      setBusy(false);
      reportHomeFailure(m(msg("Could not turn off Home")), squashAtomCommandFailure(off));
      return;
    }
    const on = await enable({
      environmentId: to.environmentId,
      input: { modelSelection: selection },
    });
    if (on._tag === "Failure") {
      setBusy(false);
      reportHomeFailure(
        m(msg("Home is off. It could not start on {environment}"), { environment: to.label }),
        squashAtomCommandFailure(on),
      );
      return;
    }
    const files = snapshot?._tag === "Success" ? snapshot.value.files : [];
    const skipped = snapshot?._tag === "Success" ? snapshot.value.skipped : [];
    const written = await writeFolder({
      environmentId: to.environmentId,
      input: { cwd: toRoot, files },
    });
    setBusy(false);
    props.onOpenChange(false);
    if (written._tag === "Failure") {
      reportHomeFailure(m(msg("Home moved without its notes")), squashAtomCommandFailure(written));
    } else if (skipped.length > 0) {
      toastManager.add({
        type: "warning",
        title: m(msg("Home moved. Some files stayed behind")),
        description: skipped.join(", "),
      });
    }
    await navigateToThread(to.environmentId, on.value.threadId);
  };

  return (
    <AlertDialogPopup>
      <AlertDialogHeader>
        <AlertDialogTitle>
          <T>
            Move Home to <Var>{to.label}</Var>?
          </T>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <T>
            Home on <Var>{props.fromLabel}</Var> stops, and a new Home thread starts on{" "}
            <Var>{to.label}</Var>. Its notes and instructions are copied over. The old thread stays
            in <Var>{props.fromLabel}</Var>'s history.
          </T>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div className="flex items-center justify-between gap-3 px-6 pb-2">
        <span className="text-sm">
          <T>
            Model on <Var>{to.label}</Var>
          </T>
        </span>
        {picker}
      </div>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="ghost" disabled={busy} />}>
          <T>Cancel</T>
        </AlertDialogClose>
        <Button
          disabled={busy || selection === null || toRoot === null}
          onClick={() => void move()}
        >
          <T>Move Home</T>
        </Button>
      </AlertDialogFooter>
    </AlertDialogPopup>
  );
}

/** Home on in two places, after a move that half failed. The user keeps one. */
function HomeConflictRows({ hosts }: { hosts: ReadonlyArray<HomeHost> }) {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
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
        reportHomeFailure(
          m(msg("Could not turn off Home on {environment}"), {
            environment: labelOf(host.environmentId),
          }),
          squashAtomCommandFailure(result),
        );
      }
    }
    setPending(false);
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("home")}
        description={gt(
          "Home is on in more than one place. Keep one; the others turn off and their threads stay.",
        )}
      />
      {hosts.map((host) => (
        <SettingsRow
          key={host.environmentId}
          title={labelOf(host.environmentId)}
          control={
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void keep(host)}>
              <T>Keep this one</T>
            </Button>
          }
        />
      ))}
    </>
  );
}
