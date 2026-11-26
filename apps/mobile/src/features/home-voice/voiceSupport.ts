export type VoiceSupport = "available" | "needsNewerIos" | "unavailable";

/** Kokoro crashes on iOS 26.4 through 26.5.x; Apple fixed it in 26.6. */
export function voiceSupport(
  hasEngine: boolean,
  os: string,
  version: string | number,
): VoiceSupport {
  if (!hasEngine || os !== "ios") return "unavailable";
  const [major, minor] = String(version).split(".").map(Number);
  return major === 26 && (minor === 4 || minor === 5) ? "needsNewerIos" : "available";
}
