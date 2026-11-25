import type {
  EnvironmentId,
  PushDeviceRegistration,
  PushLiveActivityRegistration,
} from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

// Forks whose bundle ID the official relay's APNs key cannot reach run their own
// push sender on each T3 server. That server needs this device's token, which
// the relay registration never gives it.
export function toPushDeviceRegistration(
  request: RelayDeviceRegistrationRequest,
): PushDeviceRegistration | null {
  if (
    request.platform !== "ios" ||
    !request.pushToken ||
    !request.bundleId ||
    !request.apsEnvironment
  ) {
    return null;
  }
  return {
    deviceId: request.deviceId,
    apnsToken: request.pushToken,
    apsEnvironment: request.apsEnvironment,
    bundleId: request.bundleId,
    platform: "ios",
    liveActivitiesEnabled: request.preferences.liveActivitiesEnabled,
    notificationsEnabled: request.preferences.notificationsEnabled,
    notifyOnApproval: request.preferences.notifyOnApproval,
    notifyOnInput: request.preferences.notifyOnInput,
    notifyOnCompletion: request.preferences.notifyOnCompletion,
    notifyOnFailure: request.preferences.notifyOnFailure,
  };
}

type DirectApnsState =
  | { readonly kind: "registered"; readonly registration: PushDeviceRegistration }
  | { readonly kind: "unregistered"; readonly deviceId: string };

// Android pushes go through the relay, so only iOS requests reach the server's device list.
// A missing token with permission granted is a failed lookup (cold start), not a way out.
function desiredState(request: RelayDeviceRegistrationRequest): DirectApnsState | null {
  if (request.platform !== "ios") return null;
  if (!request.preferences.notificationsEnabled) {
    return { kind: "unregistered", deviceId: request.deviceId };
  }
  const registration = toPushDeviceRegistration(request);
  return registration === null ? null : { kind: "registered", registration };
}

interface SentState {
  readonly generation: number;
  readonly signature: string;
  readonly registered: boolean;
}

// What each server last accepted, on which connection. Only successes are remembered, so an
// unreachable server is retried on the next trigger, and a new session (a reconnect or re-pair)
// sends again because the server may have dropped the device when it revoked the old one.
const sentStates = new Map<EnvironmentId, SentState>();
let lastRequest: RelayDeviceRegistrationRequest | null = null;
let watchingSessions = false;
const registeredListeners = new Set<() => void>();
const FORGET_TIMEOUT_MS = 3_000;

const enabledSessionsAtom = Atom.make((get) =>
  [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))]
    .map(
      (environmentId) =>
        `${environmentId}:${get(environmentCatalog.sessionGenerationAtom(environmentId))}`,
    )
    .join(" "),
);

function registeredEnvironmentIds(): EnvironmentId[] {
  return [...sentStates]
    .filter(([, sent]) => sent.registered)
    .map(([environmentId]) => environmentId);
}

// True once any T3 server holds this device's token.
export function isDirectApnsRegistered(): boolean {
  return registeredEnvironmentIds().length > 0;
}

export function subscribeDirectApnsRegistered(listener: () => void): () => void {
  registeredListeners.add(listener);
  return () => {
    registeredListeners.delete(listener);
  };
}

function updateSentStates(change: () => void): void {
  const wasRegistered = isDirectApnsRegistered();
  change();
  if (wasRegistered !== isDirectApnsRegistered()) {
    for (const listener of registeredListeners) listener();
  }
}

function sendState(environmentId: EnvironmentId, state: DirectApnsState) {
  const options = { reportFailure: false, reportDefect: false };
  return state.kind === "registered"
    ? runAtomCommand(
        appAtomRegistry,
        serverEnvironment.registerPushDevice,
        { environmentId, input: state.registration },
        options,
      )
    : runAtomCommand(
        appAtomRegistry,
        serverEnvironment.unregisterPushDevice,
        { environmentId, input: { deviceId: state.deviceId } },
        options,
      );
}

async function reconcileEnabledEnvironments(
  request: RelayDeviceRegistrationRequest,
): Promise<void> {
  const state = desiredState(request);
  if (state === null) return;
  const signature = JSON.stringify(state);
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  await Promise.all(
    [...enabledEnvironmentIds(catalog)].map(async (environmentId) => {
      const generation = appAtomRegistry.get(
        environmentCatalog.sessionGenerationAtom(environmentId),
      );
      const sent = sentStates.get(environmentId);
      if (sent?.generation === generation && sent.signature === signature) return;
      const result = await sendState(environmentId, state);
      if (result._tag !== "Success") return;
      updateSentStates(() => {
        sentStates.set(environmentId, {
          generation,
          signature,
          registered: state.kind === "registered",
        });
      });
    }),
  );
}

export async function registerDirectApnsDevice(
  request: RelayDeviceRegistrationRequest,
): Promise<void> {
  lastRequest = request;
  // Servers connect, reconnect and get re-paired after the app registers its token, and
  // nothing else re-triggers registration for them.
  if (!watchingSessions) {
    watchingSessions = true;
    appAtomRegistry.subscribe(enabledSessionsAtom, () => {
      if (lastRequest) void reconcileEnabledEnvironments(lastRequest);
    });
  }
  await reconcileEnabledEnvironments(request);
}

function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(done, done);
  });
}

// Call before removing servers, while they are still connected. A server that does not
// answer in time keeps the device until it next rejects or revokes it.
export async function forgetDirectApnsEnvironments(
  environmentIds: ReadonlyArray<EnvironmentId>,
): Promise<void> {
  const request = lastRequest;
  if (request?.platform === "ios") {
    const state: DirectApnsState = { kind: "unregistered", deviceId: request.deviceId };
    await Promise.all(
      environmentIds
        .filter((environmentId) => sentStates.get(environmentId)?.registered === true)
        .map((environmentId) => settleWithin(sendState(environmentId, state), FORGET_TIMEOUT_MS)),
    );
  }
  updateSentStates(() => {
    for (const environmentId of environmentIds) sentStates.delete(environmentId);
  });
}

// Only servers that already hold this device can push to its Live Activity.
export async function registerDirectLiveActivity(
  registration: PushLiveActivityRegistration,
): Promise<void> {
  await Promise.all(
    registeredEnvironmentIds().map((environmentId) =>
      runAtomCommand(
        appAtomRegistry,
        serverEnvironment.registerPushLiveActivity,
        { environmentId, input: registration },
        { reportFailure: false, reportDefect: false },
      ),
    ),
  );
}

export function __resetDirectApnsRegistrationForTest(): void {
  sentStates.clear();
  registeredListeners.clear();
  lastRequest = null;
  watchingSessions = false;
}
