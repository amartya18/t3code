import { expect, it, vi } from "vite-plus/test";

import { DEFAULT_VOICE_TUNING, voiceTuning } from "./voiceEngine";

vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.0" } }));
vi.mock("../../../modules/t3-voice-mode", () => ({ voiceEngine: null }));

it("holds a stored minimum speech above 1 s at the slider's maximum", () => {
  expect(voiceTuning({ minSpeechMs: 2_000 }).minSpeechMs).toBe(1_000);
});

it("takes the defaults back when the sliders are reset", () => {
  expect(
    voiceTuning({ minSpeechMs: undefined, minSilenceMs: undefined, turnWaitMs: undefined }),
  ).toEqual(DEFAULT_VOICE_TUNING);
});

it("lifts stored tuning below the sliders' range to their minimum and fills missing values with defaults", () => {
  expect(voiceTuning({ minSilenceMs: 0, turnWaitMs: 99_000 })).toEqual({
    minSpeechMs: DEFAULT_VOICE_TUNING.minSpeechMs,
    minSilenceMs: 200,
    turnWaitMs: 4_000,
  });
});
