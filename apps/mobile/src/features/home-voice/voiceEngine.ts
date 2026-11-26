import { requireOptionalNativeModule } from "expo";

/** Whether this build has on-device speech; without it the call screen takes typed messages. */
export function isVoiceEngineAvailable(): boolean {
  return requireOptionalNativeModule("T3VoiceMode") !== null;
}
