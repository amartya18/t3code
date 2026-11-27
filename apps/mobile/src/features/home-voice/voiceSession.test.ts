import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { QueuedThreadMessage } from "../../state/thread-outbox";
import type { HomeView, LaunchedThread } from "./homeView";
import type { VoiceModeSettings } from "./voiceSettings";

const outbox = vi.hoisted(() => ({
  queued: [] as QueuedThreadMessage[],
  failNext: false,
  ids: 0,
}));

vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${++outbox.ids}` }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => ({}),
  runAtomCommand: async () => {},
}));
vi.mock("../../state/thread-outbox", () => ({
  enqueueThreadOutboxMessage: async (message: QueuedThreadMessage) => {
    if (outbox.failNext) {
      outbox.failNext = false;
      throw new Error("disk full");
    }
    outbox.queued.push(message);
  },
}));

const { appAtomRegistry } = await import("../../state/atom-registry");
const { endVoiceSession, pushHomeUpdates, sendVoiceMessage, startVoiceSession, voiceSessionAtom } =
  await import("./voiceSession");

const START = Date.parse("2026-11-27T12:00:00.000Z");
const settings = {
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("voice"),
  modelSelection: { instanceId: "claude", model: "claude-haiku-4-5" },
} as unknown as VoiceModeSettings;
const home = { environmentId: settings.environmentId, threadId: ThreadId.make("home") };

const relay = (state: LaunchedThread["state"]): LaunchedThread => ({
  key: "env:home-launched:relay",
  title: "Fix relay",
  runId: "run-1",
  state,
  finishedAtMs: state === "finished" ? START + 60_000 : null,
  preview: "Merged.",
});
const view = (state: LaunchedThread["state"]): HomeView => ({
  homeActive: false,
  homeNeedsInput: false,
  messages: [],
  threads: [relay(state)],
});

function start() {
  startVoiceSession({ settings, home, view: view("running"), nowMs: START });
  return appAtomRegistry.get(voiceSessionAtom)!.thread;
}

beforeEach(() => {
  outbox.queued = [];
  endVoiceSession();
});

describe("a voice session", () => {
  it("opens silent, and Amar's first line creates the thread", async () => {
    const thread = start();
    expect(outbox.queued).toEqual([]);

    await sendVoiceMessage(thread, settings, "What's Home up to?");
    await sendVoiceMessage(thread, settings, "And PR 43?");
    expect(outbox.queued.map((message) => [message.text, message.creation?.projectId])).toEqual([
      ["What's Home up to?", "voice"],
      ["And PR 43?", undefined],
    ]);
    expect(outbox.queued[0]!.threadId).toBe(thread.threadId);
  });

  it("holds Home's updates until his first line, then sends them after it", async () => {
    const thread = start();
    pushHomeUpdates(thread, view("finished"));
    expect(outbox.queued).toEqual([]);

    await sendVoiceMessage(thread, settings, "Hey.");
    pushHomeUpdates(thread, view("finished"));
    pushHomeUpdates(thread, view("finished"));
    expect(outbox.queued.map((message) => message.text)).toEqual([
      "Hey.",
      '[Home update] "Fix relay" finished: Merged.',
    ]);
  });

  it("lets the next line create the thread when the first could not be queued", async () => {
    const thread = start();
    outbox.failNext = true;
    await expect(sendVoiceMessage(thread, settings, "Hello?")).rejects.toThrow("disk full");

    await sendVoiceMessage(thread, settings, "Hello again.");
    expect(outbox.queued.map((message) => message.creation?.projectId)).toEqual(["voice"]);
  });
});
