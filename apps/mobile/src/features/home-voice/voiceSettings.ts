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
import { voiceTuning, type VoiceTuning } from "./voiceEngine";

export const KOKORO_VOICES = ["af_heart", "am_michael", "bf_emma"] as const;
export type KokoroVoiceId = (typeof KOKORO_VOICES)[number];

export interface VoiceModeSettings {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelectionType;
  readonly voiceId: KokoroVoiceId;
  /** Dev only: Claude turns run with extended thinking, to compare reply latency. */
  readonly thinking: boolean;
  readonly tuning: VoiceTuning;
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
  thinking: Schema.optional(Schema.Boolean),
  minSpeechMs: Schema.optional(Schema.Number),
  minSilenceMs: Schema.optional(Schema.Number),
  turnWaitMs: Schema.optional(Schema.Number),
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
        thinking: stored.thinking ?? false,
        tuning: voiceTuning(stored),
      };
}
