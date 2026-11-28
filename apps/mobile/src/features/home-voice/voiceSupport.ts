export type VoiceSupport = "available" | "unsafeIos" | "unavailable";

/** FluidAudio's Kokoro still crashes on iOS 26.4 and later, 26.6 and 27 included. */
export function voiceSupport(
  hasEngine: boolean,
  os: string,
  version: string | number,
): VoiceSupport {
  if (!hasEngine || os !== "ios") return "unavailable";
  const [major = 0, minor = 0] = String(version).split(".").map(Number);
  return major > 26 || (major === 26 && minor >= 4) ? "unsafeIos" : "available";
}
