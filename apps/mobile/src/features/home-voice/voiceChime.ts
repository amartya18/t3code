import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";

const CHIMES = {
  start: { source: require("./call-start.wav"), durationMs: 380 },
  end: { source: require("./call-end.wav"), durationMs: 320 },
} as const;
/** A player that never reports its end can't hold up the call by more than this. */
const FINISH_SLACK_MS = 400;

/**
 * Plays a call chime with the voice engine stopped, and hands the audio session back inactive.
 * Expo deactivates the session 100 ms after playback ends; turning its audio off first makes that
 * a no-op, so it can't cut off the session the engine activates right after.
 */
export async function playVoiceChime(sound: keyof typeof CHIMES): Promise<void> {
  const { source, durationMs } = CHIMES[sound];
  await setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: "mixWithOthers",
    shouldPlayInBackground: true,
    allowsRecording: false,
  });
  await setIsAudioActiveAsync(true);
  const player = createAudioPlayer(source);
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, durationMs + FINISH_SLACK_MS);
      player.addListener("playbackStatusUpdate", (status) => {
        if (!status.didJustFinish) return;
        clearTimeout(timer);
        resolve();
      });
      player.play();
    });
  } finally {
    player.remove();
    await setIsAudioActiveAsync(false);
  }
}
