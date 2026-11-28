import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceSession } from "./voiceSession";
import type { VoiceModeSettings } from "./voiceSettings";

const spies = vi.hoisted(() => ({ alert: vi.fn(), navigate: vi.fn() }));

vi.mock("../../components/ui/Dialog", () => ({ alert: spies.alert }));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { navigate: spies.navigate },
  whenRootNavigationReady: (navigate: () => void) => navigate(),
}));
vi.mock("../../state/home", async () => {
  const { Atom } = await import("effect/reactivity");
  return { userHomeAtom: Atom.make<unknown>({ kind: "off" }) };
});
vi.mock("../../state/threads", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: { threadShellsAtom: Atom.make<ReadonlyArray<unknown>>([]) },
    environmentThreads: { stateAtom: () => Atom.make(AsyncResult.initial()) },
  };
});
vi.mock("./voiceSettings", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    storedVoiceSettingsLoaded: Promise.resolve(),
    voiceModeSettingsAtom: Atom.make<unknown>(null),
  };
});
vi.mock("./voiceSession", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("../../state/atom-registry");
  const voiceSessionAtom = Atom.make<unknown>(null);
  return {
    voiceSessionAtom,
    startVoiceSession: (input: { readonly home: unknown }) =>
      appAtomRegistry.set(voiceSessionAtom, { home: input.home }),
  };
});

const { appAtomRegistry } = await import("../../state/atom-registry");
const { userHomeAtom } = await import("../../state/home");
const { environmentThreadShells } = await import("../../state/threads");
const { voiceModeSettingsAtom } = await import("./voiceSettings");
const { voiceSessionAtom } = await import("./voiceSession");
const { VOICE_CALL_LINK_WAIT_MS, firstValue, takeVoiceCallLink, voiceCallStart } =
  await import("./homeVoiceCall");

const writable = <A>(atom: unknown) => atom as Atom.Writable<A>;
const environmentId = EnvironmentId.make("env");
const home = { environmentId, threadId: ThreadId.make("home") };
const homeShell = { environmentId, id: home.threadId } as EnvironmentThreadShell;
const settings = { environmentId } as VoiceModeSettings;

// What React Navigation parses `t3code://voice` into, given voiceRoutes' `linking: "voice"`.
const voiceLink = () => ({ routes: [{ name: "Home" }, { name: "VoiceCall" }] });

function homeConnects() {
  appAtomRegistry.set(writable(userHomeAtom), { kind: "on", ...home });
  appAtomRegistry.set(writable(environmentThreadShells.threadShellsAtom), [homeShell]);
  appAtomRegistry.set(writable(voiceModeSettingsAtom), settings);
}

beforeEach(() => {
  vi.useFakeTimers();
  appAtomRegistry.set(writable(userHomeAtom), { kind: "off" });
  appAtomRegistry.set(writable(environmentThreadShells.threadShellsAtom), []);
  appAtomRegistry.set(writable(voiceModeSettingsAtom), null);
  appAtomRegistry.set(writable(voiceSessionAtom), null);
});

afterEach(() => {
  vi.useRealTimers();
  spies.alert.mockReset();
  spies.navigate.mockReset();
});

describe("voiceCallStart", () => {
  it("waits for the Voice project and Home's thread", () => {
    expect(voiceCallStart({ settings: null, home, shells: [homeShell] })).toBeNull();
    expect(voiceCallStart({ settings, home: null, shells: [homeShell] })).toBeNull();
    expect(voiceCallStart({ settings, home, shells: [] })).toBeNull();
    expect(voiceCallStart({ settings, home, shells: [homeShell] })).toEqual({
      settings,
      homeShell,
    });
  });
});

describe("firstValue", () => {
  it("resolves with the first value that arrives", async () => {
    const registry = AtomRegistry.make();
    const atom = Atom.make<number | null>(null);
    const value = firstValue(registry, atom, 1_000);
    registry.set(atom, 7);
    await expect(value).resolves.toBe(7);
  });

  it("resolves null when nothing arrives in time", async () => {
    const registry = AtomRegistry.make();
    const value = firstValue(registry, Atom.make<number | null>(null), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(value).resolves.toBeNull();
  });
});

describe("takeVoiceCallLink", () => {
  it("passes other links through", () => {
    const state = { routes: [{ name: "Home" }, { name: "Settings" }] };
    expect(takeVoiceCallLink(state)).toBe(state);
  });

  it("on a cold launch, starts the call once Home connects, then shows it", async () => {
    expect(takeVoiceCallLink(voiceLink())).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spies.navigate).not.toHaveBeenCalled();

    homeConnects();
    await vi.advanceTimersByTimeAsync(0);
    expect(appAtomRegistry.get(voiceSessionAtom)).toEqual({ home });
    expect(spies.navigate).toHaveBeenCalledWith("VoiceCall");
    expect(spies.alert).not.toHaveBeenCalled();
  });

  it("shows a running call without starting another", async () => {
    const running = { home: { environmentId, threadId: ThreadId.make("other") } };
    appAtomRegistry.set(writable(voiceSessionAtom), running as unknown as VoiceSession);
    takeVoiceCallLink(voiceLink());
    await vi.advanceTimersByTimeAsync(0);
    expect(appAtomRegistry.get(voiceSessionAtom)).toBe(running);
    expect(spies.navigate).toHaveBeenCalledWith("VoiceCall");
  });

  it("alerts when Home never connects", async () => {
    takeVoiceCallLink(voiceLink());
    await vi.advanceTimersByTimeAsync(VOICE_CALL_LINK_WAIT_MS);
    expect(spies.navigate).not.toHaveBeenCalled();
    expect(spies.alert).toHaveBeenCalledWith("No Voice project", expect.any(String));
  });

  it("alerts that Home is offline when only the Voice project is known", async () => {
    appAtomRegistry.set(writable(voiceModeSettingsAtom), settings);
    takeVoiceCallLink(voiceLink());
    await vi.advanceTimersByTimeAsync(VOICE_CALL_LINK_WAIT_MS);
    expect(spies.alert).toHaveBeenCalledWith("Home isn't connected", expect.any(String));
  });
});
