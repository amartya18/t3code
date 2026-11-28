import {
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ModelSelection,
  type ProjectId,
  type ServerConfig,
} from "@t3tools/contracts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const VOICE_CLAUDE = ProviderInstanceId.make("claudeVoice");
const VOICE_CLAUDE_THINKING = ProviderInstanceId.make("claudeVoiceThinking");
export const isVoiceInstance = (instanceId: ProviderInstanceId) =>
  instanceId === VOICE_CLAUDE || instanceId === VOICE_CLAUDE_THINKING;

export function voiceInstanceEnabled(
  config: Pick<ServerConfig, "providers" | "settings"> | null | undefined,
  projectId: ProjectId,
): (instanceId: ProviderInstanceId) => boolean {
  return (instanceId) => {
    const provider = config?.providers.find((entry) => entry.instanceId === instanceId);
    if (provider === undefined) return false;
    return config?.settings
      ? resolveProjectProviderInstanceEnabled(config.settings, projectId, instanceId)
      : provider.enabled;
  };
}

/**
 * Claude picks run on the server's voice instances where it has them (no tool search, thinking
 * per the dev toggle); every other pick, or a server without them, sends unchanged.
 */
export function voiceTurnSelection(
  selection: ModelSelection,
  isEnabled: (instanceId: ProviderInstanceId) => boolean,
  thinking: boolean,
): ModelSelection {
  if (selection.instanceId !== CLAUDE) return selection;
  const instanceId = thinking ? VOICE_CLAUDE_THINKING : VOICE_CLAUDE;
  return isEnabled(instanceId) ? { ...selection, instanceId } : selection;
}
