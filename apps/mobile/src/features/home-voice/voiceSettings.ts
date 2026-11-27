import { useAtomValue } from "@effect/atom-react";
import { userHomeThreadRef } from "@t3tools/client-runtime/state/home";
import {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection as ModelSelectionType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { writeFileAtomically } from "../../lib/atomic-file";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects } from "../../state/entities";
import { userHomeAtom } from "../../state/home";
import {
  DEFAULT_BARGE_IN_CONFIG,
  INTERRUPT_MODES,
  RECOVERY_MODES,
  type InterruptMode,
  type RecoveryMode,
} from "./speechQueue";

export const KOKORO_VOICES = ["af_heart", "am_michael", "bf_emma"] as const;
export type KokoroVoiceId = (typeof KOKORO_VOICES)[number];

export const PAUSE_MIN_MS = 500;
export const PAUSE_MAX_MS = 5_000;
export const SMART_CUTOFF_MIN_MS = 250;
export const SMART_CUTOFF_MAX_MS = 3_000;

export interface VoiceModeSettings {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelectionType;
  readonly voiceId: KokoroVoiceId;
  /** Silence before a spoken message sends. */
  readonly pauseMs: number;
  /** Send before the pause ends when the speech sounds finished. */
  readonly earlySend: boolean;
  /** Dev only: what stops the voice when Amar talks over it, and what a false alarm does. */
  readonly interruptMode: InterruptMode;
  readonly recovery: RecoveryMode;
  readonly smartCutoffMs: number;
  /** Dev only: Claude turns run with extended thinking, to compare reply latency. */
  readonly thinking: boolean;
}

const DEFAULT_VOICE_MODEL: ModelSelectionType = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "low" }],
};

const VOICE_PROJECT_TITLE = "voice";

const StoredVoiceSettings = Schema.Struct({
  environmentId: Schema.optional(EnvironmentId),
  projectId: Schema.optional(ProjectId),
  modelSelection: Schema.optional(ModelSelection),
  voiceId: Schema.optional(Schema.Literals(KOKORO_VOICES)),
  pauseMs: Schema.optional(Schema.Number),
  earlySend: Schema.optional(Schema.Boolean),
  interruptMode: Schema.optional(Schema.Literals(INTERRUPT_MODES)),
  recovery: Schema.optional(Schema.Literals(RECOVERY_MODES)),
  smartCutoffMs: Schema.optional(Schema.Number),
  thinking: Schema.optional(Schema.Boolean),
});
type StoredVoiceSettings = typeof StoredVoiceSettings.Type;
const StoredVoiceSettingsJson = Schema.fromJsonString(StoredVoiceSettings);
const decodeStoredVoiceSettings = Schema.decodeSync(StoredVoiceSettingsJson);
const encodeStoredVoiceSettings = Schema.encodeSync(StoredVoiceSettingsJson);

const storedVoiceSettingsAtom = Atom.make<StoredVoiceSettings>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("home-voice:settings"),
);

async function settingsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, "home-voice-settings.json");
}

let changedBeforeLoad = false;
void settingsFile()
  .then(async (file) => (file.exists ? await file.text() : null))
  .then((raw) => {
    if (raw === null || changedBeforeLoad) return;
    appAtomRegistry.set(storedVoiceSettingsAtom, decodeStoredVoiceSettings(raw));
  })
  .catch(() => {});

/** Saves a per-device choice; omitted fields keep their stored value. */
export async function saveVoiceSettings(patch: StoredVoiceSettings) {
  changedBeforeLoad = true;
  const next = { ...appAtomRegistry.get(storedVoiceSettingsAtom), ...patch };
  appAtomRegistry.set(storedVoiceSettingsAtom, next);
  await writeFileAtomically(await settingsFile(), encodeStoredVoiceSettings(next));
}

/**
 * The stored choice where it still exists, else Home's environment and its project titled
 * "Voice". Null when no Voice project is found.
 */
export function useVoiceModeSettings(): VoiceModeSettings | null {
  const stored = useAtomValue(storedVoiceSettingsAtom);
  const home = userHomeThreadRef(useAtomValue(userHomeAtom));
  const projects = useProjects();
  const storedProject = projects.find(
    (project) => project.environmentId === stored.environmentId && project.id === stored.projectId,
  );
  const project =
    storedProject ??
    projects.find(
      (project) =>
        project.environmentId === home?.environmentId &&
        project.title.trim().toLowerCase() === VOICE_PROJECT_TITLE,
    );
  return project === undefined
    ? null
    : {
        environmentId: project.environmentId,
        projectId: project.id,
        modelSelection: stored.modelSelection ?? DEFAULT_VOICE_MODEL,
        voiceId: stored.voiceId ?? "af_heart",
        pauseMs: Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, stored.pauseMs ?? 3_000)),
        earlySend: stored.earlySend ?? true,
        interruptMode: stored.interruptMode ?? DEFAULT_BARGE_IN_CONFIG.mode,
        recovery: stored.recovery ?? DEFAULT_BARGE_IN_CONFIG.recovery,
        smartCutoffMs: Math.min(
          SMART_CUTOFF_MAX_MS,
          Math.max(
            SMART_CUTOFF_MIN_MS,
            stored.smartCutoffMs ?? DEFAULT_BARGE_IN_CONFIG.smartCutoffMs,
          ),
        ),
        thinking: stored.thinking ?? false,
      };
}
