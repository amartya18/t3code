import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";

const mocks = vi.hoisted(() => ({
  runAtomCommand: vi.fn(),
  environmentIds: [] as string[],
  generations: new Map<string, number>(),
  catalogListeners: [] as Array<() => void>,
  shownCards: 1,
}));

vi.mock("./agentLiveActivity", () => ({
  dismissEndedAgentLiveActivities: () => undefined,
  getAgentLiveActivities: () => Array.from({ length: mocks.shownCards }),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
}));
vi.mock("@t3tools/client-runtime/state/connections", () => ({
  enabledEnvironmentIds: () => mocks.environmentIds,
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: {
    catalogValueAtom: Symbol("catalog"),
    sessionGenerationAtom: (environmentId: string) => ({ generationOf: environmentId }),
  },
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      typeof atom === "object" && atom !== null && "generationOf" in atom
        ? (mocks.generations.get(String(atom.generationOf)) ?? 1)
        : {},
    subscribe: (_atom: unknown, listener: () => void) => {
      mocks.catalogListeners.push(listener);
      return () => undefined;
    },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    registerPushDevice: { label: "register" },
    unregisterPushDevice: { label: "unregister" },
    registerPushLiveActivity: { label: "register-live-activity" },
  },
}));

import {
  __resetDirectApnsRegistrationForTest,
  forgetDirectApnsEnvironments,
  isDirectApnsRegistered,
  registerDirectApnsDevice,
  registerDirectLiveActivity,
  toPushDeviceRegistration,
} from "./directApnsRegistration";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");

const request = (
  overrides: Partial<RelayDeviceRegistrationRequest> = {},
): RelayDeviceRegistrationRequest => ({
  deviceId: "device-1",
  label: "iPhone",
  platform: "ios",
  iosMajorVersion: 18,
  bundleId: "com.example.t3code",
  apsEnvironment: "sandbox",
  pushToken: "ab".repeat(32),
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: false,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  ...overrides,
});

beforeEach(() => {
  mocks.runAtomCommand.mockReset();
  mocks.runAtomCommand.mockResolvedValue({ _tag: "Success" });
  mocks.environmentIds = [ENV_A, ENV_B];
  mocks.generations.clear();
  mocks.catalogListeners.length = 0;
  mocks.shownCards = 1;
  __resetDirectApnsRegistrationForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

const sent = () =>
  mocks.runAtomCommand.mock.calls.map(([, command, target]) => [
    command.label,
    target.environmentId,
    target.input,
  ]);

describe("toPushDeviceRegistration", () => {
  it("maps the relay registration onto the direct push registration", () => {
    expect(toPushDeviceRegistration(request())).toEqual({
      deviceId: "device-1",
      apnsToken: "ab".repeat(32),
      apsEnvironment: "sandbox",
      bundleId: "com.example.t3code",
      platform: "ios",
      liveActivitiesEnabled: true,
      notificationsEnabled: true,
      notifyOnApproval: true,
      notifyOnInput: false,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    });
  });

  it("has nothing to register without a token, bundle ID or APNs environment, or on Android", () => {
    const { pushToken: _token, ...withoutToken } = request();
    expect(toPushDeviceRegistration(withoutToken)).toBeNull();
    const { bundleId: _bundle, ...withoutBundle } = request();
    expect(toPushDeviceRegistration(withoutBundle)).toBeNull();
    const { apsEnvironment: _env, ...withoutEnvironment } = request();
    expect(toPushDeviceRegistration(withoutEnvironment)).toBeNull();
    expect(
      toPushDeviceRegistration(
        request({
          platform: "android",
          androidApiLevel: 35,
        } as Partial<RelayDeviceRegistrationRequest>),
      ),
    ).toBeNull();
  });
});

describe("registerDirectApnsDevice", () => {
  it("registers with every connected environment", async () => {
    await registerDirectApnsDevice(request());
    expect(mocks.runAtomCommand.mock.calls.map(([, , target]) => target.environmentId)).toEqual([
      ENV_A,
      ENV_B,
    ]);
    expect(mocks.runAtomCommand.mock.calls[0]?.[2].input.apnsToken).toBe("ab".repeat(32));
  });

  it("skips environments that already hold this exact registration, and resends on change", async () => {
    mocks.environmentIds = [ENV_A];
    await registerDirectApnsDevice(request());
    await registerDirectApnsDevice(request());
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    await registerDirectApnsDevice(request({ pushToken: "cd".repeat(32) }));
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(2);
  });

  it("retries an environment whose registration failed and never throws", async () => {
    mocks.environmentIds = [ENV_A];
    mocks.runAtomCommand.mockResolvedValueOnce({ _tag: "Failure" });
    await expect(registerDirectApnsDevice(request())).resolves.toBeUndefined();
    await registerDirectApnsDevice(request());
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(2);
  });

  it("reports registered only once a server accepted the token", async () => {
    mocks.environmentIds = [ENV_A];
    mocks.runAtomCommand.mockResolvedValueOnce({ _tag: "Failure" });
    await registerDirectApnsDevice(request());
    expect(isDirectApnsRegistered()).toBe(false);
    await registerDirectApnsDevice(request());
    expect(isDirectApnsRegistered()).toBe(true);
  });

  it("registers environments that connect after the token was registered", async () => {
    mocks.environmentIds = [ENV_A];
    await registerDirectApnsDevice(request());
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    mocks.environmentIds = [ENV_A, ENV_B];
    mocks.catalogListeners[0]?.();
    await vi.waitFor(() => expect(mocks.runAtomCommand).toHaveBeenCalledTimes(2));
    expect(mocks.runAtomCommand.mock.calls[1]?.[2].environmentId).toBe(ENV_B);
    // A later registration does not stack a second catalog subscription.
    await registerDirectApnsDevice(request({ pushToken: "cd".repeat(32) }));
    expect(mocks.catalogListeners).toHaveLength(1);
  });
});

describe("registerDirectLiveActivity", () => {
  it("sends the card's token only to servers that accepted this device", async () => {
    mocks.runAtomCommand.mockImplementation(async (_registry, _command, target) =>
      target.environmentId === ENV_A ? { _tag: "Success" } : { _tag: "Failure" },
    );
    await registerDirectApnsDevice(request());
    mocks.runAtomCommand.mockClear();
    const registration = { deviceId: "device-1", activityPushToken: "ef".repeat(40) };
    await registerDirectLiveActivity(registration);
    expect(mocks.runAtomCommand.mock.calls.map(([, command, target]) => [command, target])).toEqual(
      [[{ label: "register-live-activity" }, { environmentId: ENV_A, input: registration }]],
    );
  });

  it("sends a card started before any server took the device once one does", async () => {
    mocks.environmentIds = [ENV_A];
    mocks.runAtomCommand.mockResolvedValueOnce({ _tag: "Failure" });
    await registerDirectApnsDevice(request());
    const registration = { deviceId: "device-1", activityPushToken: "ef".repeat(40) };
    await registerDirectLiveActivity(registration);
    expect(sent().filter(([label]) => label === "register-live-activity")).toEqual([]);

    await registerDirectApnsDevice(request());
    expect(sent().slice(-2)).toEqual([
      ["register", ENV_A, toPushDeviceRegistration(request())],
      ["register-live-activity", ENV_A, registration],
    ]);
  });

  it("never brings back the token of a card that has ended", async () => {
    mocks.environmentIds = [ENV_A];
    await registerDirectApnsDevice(request());
    await registerDirectLiveActivity({ deviceId: "device-1", activityPushToken: "ef".repeat(40) });
    mocks.runAtomCommand.mockClear();

    // The card ended, then the server reconnects twice; a later card must not revive it.
    mocks.shownCards = 0;
    mocks.generations.set(ENV_A, 2);
    await registerDirectApnsDevice(request());
    mocks.shownCards = 1;
    mocks.generations.set(ENV_A, 3);
    await registerDirectApnsDevice(request());

    expect(sent().map(([label]) => label)).toEqual(["register", "register"]);
  });
});

const withPreferences = (
  preferences: Partial<RelayDeviceRegistrationRequest["preferences"]>,
  base = request(),
): RelayDeviceRegistrationRequest => ({
  ...base,
  preferences: { ...base.preferences, ...preferences },
});

describe("card-only registration", () => {
  it("keeps the device on every server for its card, with alerts off, while notifications are off", async () => {
    await registerDirectApnsDevice(request());
    mocks.runAtomCommand.mockClear();

    await registerDirectApnsDevice(withPreferences({ notificationsEnabled: false }));
    const cardOnly = { ...toPushDeviceRegistration(request())!, notificationsEnabled: false };
    expect(sent()).toEqual([
      ["register", ENV_A, cardOnly],
      ["register", ENV_B, cardOnly],
    ]);
    // Settings must not report notifications as working.
    expect(isDirectApnsRegistered()).toBe(false);
  });

  it("sends a card started with notifications off to the servers that hold the device", async () => {
    mocks.environmentIds = [ENV_A];
    await registerDirectApnsDevice(withPreferences({ notificationsEnabled: false }));
    const registration = { deviceId: "device-1", activityPushToken: "ef".repeat(40) };
    await registerDirectLiveActivity(registration);
    expect(sent().at(-1)).toEqual(["register-live-activity", ENV_A, registration]);
  });

  it("registers with alerts again once notification permission is back", async () => {
    mocks.environmentIds = [ENV_A];
    await registerDirectApnsDevice(withPreferences({ notificationsEnabled: false }));
    mocks.runAtomCommand.mockClear();
    await registerDirectApnsDevice(request());
    expect(sent()).toEqual([["register", ENV_A, toPushDeviceRegistration(request())]]);
    expect(isDirectApnsRegistered()).toBe(true);
  });

  it("with Live Activities off too, stays until the card still showing is gone, then unregisters", async () => {
    mocks.environmentIds = [ENV_A];
    await registerDirectApnsDevice(withPreferences({ notificationsEnabled: false }));
    mocks.runAtomCommand.mockClear();
    const bothOff = withPreferences({ notificationsEnabled: false, liveActivitiesEnabled: false });
    // The server ends a card it holds once the device says Live Activities are off.
    await registerDirectApnsDevice(bothOff);
    expect(sent()).toEqual([["register", ENV_A, toPushDeviceRegistration(bothOff)]]);

    mocks.runAtomCommand.mockClear();
    mocks.shownCards = 0;
    await registerDirectApnsDevice(bothOff);
    expect(sent()).toEqual([["unregister", ENV_A, { deviceId: "device-1" }]]);

    mocks.runAtomCommand.mockClear();
    const registration = { deviceId: "device-1", activityPushToken: "ef".repeat(40) };
    await registerDirectLiveActivity(registration);
    expect(sent()).toEqual([]);
  });
});

describe("leaving a server's push list", () => {
  it("unregisters once notification permission is off with no token, and registers again once it is back", async () => {
    await registerDirectApnsDevice(request());
    mocks.runAtomCommand.mockClear();
    const { pushToken: _token, ...withoutToken } = request();
    await registerDirectApnsDevice({
      ...withoutToken,
      preferences: { ...withoutToken.preferences, notificationsEnabled: false },
    });
    expect(sent()).toEqual([
      ["unregister", ENV_A, { deviceId: "device-1" }],
      ["unregister", ENV_B, { deviceId: "device-1" }],
    ]);
    expect(isDirectApnsRegistered()).toBe(false);

    mocks.runAtomCommand.mockClear();
    await registerDirectApnsDevice(request());
    expect(sent().map(([label, environmentId]) => [label, environmentId])).toEqual([
      ["register", ENV_A],
      ["register", ENV_B],
    ]);
  });

  it("stays registered when the token lookup fails while permission is granted", async () => {
    await registerDirectApnsDevice(request());
    mocks.runAtomCommand.mockClear();
    const { pushToken: _token, ...withoutToken } = request();
    await registerDirectApnsDevice(withoutToken);
    expect(sent()).toEqual([]);
    expect(isDirectApnsRegistered()).toBe(true);
  });

  it("unregisters from a forgotten server without waiting on one that never answers", async () => {
    await registerDirectApnsDevice(request());
    mocks.runAtomCommand.mockClear();
    mocks.runAtomCommand.mockReturnValue(new Promise(() => undefined));
    vi.useFakeTimers();
    const forgotten = forgetDirectApnsEnvironments([ENV_A]);
    await vi.runAllTimersAsync();
    await expect(forgotten).resolves.toBeUndefined();
    expect(sent()).toEqual([["unregister", ENV_A, { deviceId: "device-1" }]]);

    mocks.runAtomCommand.mockReset();
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Success" });
    const registration = { deviceId: "device-1", activityPushToken: "ef".repeat(40) };
    await registerDirectLiveActivity(registration);
    expect(sent()).toEqual([["register-live-activity", ENV_B, registration]]);
  });

  it("forgets a server that never took the device without calling it", async () => {
    mocks.environmentIds = [ENV_A];
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Failure" });
    await registerDirectApnsDevice(request());
    mocks.runAtomCommand.mockClear();
    await forgetDirectApnsEnvironments([ENV_A]);
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
  });

  it("registers again on each new session, so a re-paired server holds the device", async () => {
    mocks.environmentIds = [ENV_A];
    await registerDirectApnsDevice(request());
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    mocks.generations.set(ENV_A, 2);
    mocks.catalogListeners[0]?.();
    await vi.waitFor(() => expect(mocks.runAtomCommand).toHaveBeenCalledTimes(2));
    expect(sent()[1]?.slice(0, 2)).toEqual(["register", ENV_A]);
  });

  it("leaves servers alone on Android", async () => {
    const android = request({
      platform: "android",
      androidApiLevel: 35,
    } as Partial<RelayDeviceRegistrationRequest>);
    await registerDirectApnsDevice(android);
    await forgetDirectApnsEnvironments([ENV_A]);
    expect(mocks.runAtomCommand).not.toHaveBeenCalled();
  });
});
