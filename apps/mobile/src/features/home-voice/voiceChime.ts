import { Asset } from "expo-asset";

import type { VoiceEngine } from "../../../modules/t3-voice-mode";

const CHIMES = {
  start: require("./call-start.wav"),
  end: require("./call-end.wav"),
} as const;

/** Plays through the call's engine, so the chime takes the call's route and the echo canceller hears it. */
export async function playVoiceChime(
  engine: VoiceEngine,
  sound: keyof typeof CHIMES,
): Promise<void> {
  const asset = await Asset.fromModule(CHIMES[sound]).downloadAsync();
  await engine.playChime(asset.localUri ?? asset.uri);
}
