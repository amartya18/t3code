import { ProviderInstanceId, type ModelSelection, type ServerProvider } from "@t3tools/contracts";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const VOICE_CLAUDE = ProviderInstanceId.make("claudeVoice");
const VOICE_CLAUDE_THINKING = ProviderInstanceId.make("claudeVoiceThinking");
export const isVoiceInstance = (instanceId: ProviderInstanceId) =>
  instanceId === VOICE_CLAUDE || instanceId === VOICE_CLAUDE_THINKING;

/**
 * Claude picks run on the server's voice instances where it has them (no tool search, thinking
 * per the dev toggle); every other pick, or a server without them, sends unchanged.
 */
export function voiceTurnSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "enabled">>,
  thinking: boolean,
): ModelSelection {
  if (selection.instanceId !== CLAUDE) return selection;
  const instanceId = thinking ? VOICE_CLAUDE_THINKING : VOICE_CLAUDE;
  return providers.some((provider) => provider.instanceId === instanceId && provider.enabled)
    ? { ...selection, instanceId }
    : selection;
}
