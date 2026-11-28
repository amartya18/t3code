import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.0" } }));
vi.mock("../../../modules/t3-voice-mode", () => ({ voiceEngine: null }));
vi.mock("expo-file-system", () => ({}));
vi.mock("../../lib/atomic-file", () => ({ writeFileAtomically: async () => {} }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/home", () => ({ userHomeAtom: Atom.make(null) }));

const { voiceModeSettings } = await import("./voiceSettings");

const project = { environmentId: EnvironmentId.make("env"), id: ProjectId.make("voice") };

it("runs Kokoro off the GPU until the dev toggle turns it on", () => {
  expect(voiceModeSettings({}, project).kokoroGpu).toBe(false);
  expect(voiceModeSettings({ kokoroGpu: true }, project).kokoroGpu).toBe(true);
});
