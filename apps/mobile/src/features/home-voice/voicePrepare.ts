import {
  voiceEngine,
  type VoiceEngine,
  type VoiceEngineConfig,
  type VoiceModelPart,
} from "../../../modules/t3-voice-mode";
import { isVoiceEngineAvailable, voiceEngineConfig } from "./voiceEngine";
import { voiceDevLog } from "./voiceLogUpload";
import type { VoiceModeSettings } from "./voiceSettings";

const PARTS: ReadonlyArray<VoiceModelPart> = ["vad", "asr", "turn", "tts"];

export function shouldPrepareVoice(input: {
  readonly available: boolean;
  readonly hasVoiceProject: boolean;
  readonly alreadyAsked: boolean;
}): boolean {
  return input.available && input.hasVoiceProject && !input.alreadyAsked;
}

export async function prepareVoice(
  engine: VoiceEngine,
  config: VoiceEngineConfig,
  log: (line: string) => void,
  now: () => number,
): Promise<void> {
  try {
    await engine.configure(config);
    const status = await engine.modelStatus();
    if (status.state !== "ready") {
      log(`[voice] prepare skipped: models ${status.state}`);
      return;
    }
    log("[voice] prepare start");
    const startedAt = now();
    const { loadMs } = await engine.prepare();
    const parts = PARTS.filter((part) => loadMs[part] !== undefined);
    log(
      parts.length === 0
        ? "[voice] prepare: the engine was busy, nothing loaded"
        : `[voice] prepare: ${parts.map((part) => `${part} ${loadMs[part]}ms`).join(", ")}, ` +
            `total ${Math.round(now() - startedAt)}ms`,
    );
  } catch (error) {
    log(`[voice] prepare failed: ${String(error)}`);
  }
}

let asked = false;

export function prepareVoiceOnce(settings: VoiceModeSettings | null) {
  const due = shouldPrepareVoice({
    available: isVoiceEngineAvailable(),
    hasVoiceProject: settings !== null,
    alreadyAsked: asked,
  });
  if (!due || voiceEngine === null || settings === null) return;
  asked = true;
  void prepareVoice(
    voiceEngine,
    voiceEngineConfig(settings.voiceId, settings.tuning, settings.kokoroGpu),
    voiceDevLog,
    Date.now,
  );
}
