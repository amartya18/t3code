import { expect, it, vi } from "vite-plus/test";

import type { VoiceEngine, VoiceModelStatus } from "../../../modules/t3-voice-mode";
import { DEFAULT_VOICE_TUNING, voiceEngineConfig } from "./voiceEngine";
import { prepareVoice, shouldPrepareVoice } from "./voicePrepare";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.0" } }));
vi.mock("../../../modules/t3-voice-mode", () => ({ voiceEngine: null }));
vi.mock("./voiceLogUpload", () => ({ voiceDevLog: () => {} }));
vi.stubGlobal("__DEV__", true);

it("warms the voice up once, only on a build with speech and with a Voice project", () => {
  const due = { available: true, hasVoiceProject: true, alreadyAsked: false };
  expect(shouldPrepareVoice(due)).toBe(true);
  expect(shouldPrepareVoice({ ...due, alreadyAsked: true })).toBe(false);
  expect(shouldPrepareVoice({ ...due, available: false })).toBe(false);
  expect(shouldPrepareVoice({ ...due, hasVoiceProject: false })).toBe(false);
});

function fakeEngine(state: VoiceModelStatus["state"]) {
  const calls: string[] = [];
  const engine = {
    configure: async (config) => {
      calls.push(`configure gpu ${config.tts.gpu}`);
    },
    modelStatus: async () => ({ state, bytesOnDisk: 1 }),
    prepare: async () => {
      calls.push("prepare");
      return { loadMs: { tts: 2400, vad: 80, asr: 3100, turn: 150 } };
    },
  } as Pick<VoiceEngine, "configure" | "modelStatus" | "prepare"> as VoiceEngine;
  return { engine, calls };
}

it("loads downloaded models with the session's Kokoro route and logs each model's time", async () => {
  const { engine, calls } = fakeEngine("ready");
  const logs: string[] = [];
  let clock = 0;
  await prepareVoice(
    engine,
    voiceEngineConfig("af_heart", DEFAULT_VOICE_TUNING, false),
    (line) => logs.push(line),
    () => (clock += 3_200),
  );

  expect(calls).toEqual(["configure gpu false", "prepare"]);
  expect(logs).toEqual([
    "[voice] prepare start",
    "[voice] prepare: vad 80ms, asr 3100ms, turn 150ms, tts 2400ms, total 3200ms",
  ]);
});

it("loads nothing while the models aren't downloaded", async () => {
  const { engine, calls } = fakeEngine("partial");
  const logs: string[] = [];
  await prepareVoice(
    engine,
    voiceEngineConfig("af_heart", DEFAULT_VOICE_TUNING, false),
    (line) => logs.push(line),
    () => 0,
  );

  expect(calls).toEqual(["configure gpu false"]);
  expect(logs).toEqual(["[voice] prepare skipped: models partial"]);
});
