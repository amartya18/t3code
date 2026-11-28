import { ProjectId, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isVoiceInstance, voiceInstanceEnabled, voiceTurnSelection } from "./voiceInstances";

const instance = (id: string, enabled = true) => ({
  instanceId: ProviderInstanceId.make(id),
  enabled,
});
const opus: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "low" }],
};
const listed =
  (...providers: ReadonlyArray<ReturnType<typeof instance>>) =>
  (id: ProviderInstanceId) =>
    providers.some((provider) => provider.instanceId === id && provider.enabled);
const voiceServer = listed(
  instance("claudeAgent"),
  instance("claudeVoice"),
  instance("claudeVoiceThinking"),
);

describe("voiceTurnSelection", () => {
  it("runs a Claude pick without thinking on the server's voice instance", () => {
    expect(voiceTurnSelection(opus, voiceServer, false)).toEqual({
      ...opus,
      instanceId: "claudeVoice",
    });
  });

  it("runs a Claude pick with thinking on the thinking voice instance", () => {
    expect(voiceTurnSelection(opus, voiceServer, true)).toEqual({
      ...opus,
      instanceId: "claudeVoiceThinking",
    });
  });

  it("sends unchanged to a server without the voice instances", () => {
    expect(voiceTurnSelection(opus, listed(instance("claudeAgent")), false)).toBe(opus);
    expect(voiceTurnSelection(opus, listed(instance("claudeAgent")), true)).toBe(opus);
    expect(voiceTurnSelection(opus, listed(), false)).toBe(opus);
  });

  it("sends unchanged when the needed voice instance is turned off", () => {
    const off = listed(instance("claudeAgent"), instance("claudeVoice", false));
    expect(voiceTurnSelection(opus, off, false)).toBe(opus);
  });

  it("leaves other providers alone", () => {
    const codex: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.5",
    };
    expect(voiceTurnSelection(codex, voiceServer, false)).toBe(codex);
    expect(voiceTurnSelection(codex, voiceServer, true)).toBe(codex);
  });
});

describe("voiceInstanceEnabled", () => {
  const voiceProject = ProjectId.make("voice-project");
  const config = {
    providers: [instance("claudeAgent"), instance("claudeVoice", false)],
    settings: {
      providerInstances: {
        [ProviderInstanceId.make("claudeVoice")]: { driver: "claudeAgent", enabled: false },
      },
      projectSettingsOverrides: {
        [voiceProject]: {
          providerInstances: { [ProviderInstanceId.make("claudeVoice")]: { enabled: true } },
        },
      },
    },
  } as unknown as Parameters<typeof voiceInstanceEnabled>[0];

  it("uses an instance that is off everywhere except the voice project", () => {
    const enabled = voiceInstanceEnabled(config, voiceProject);
    expect(enabled(ProviderInstanceId.make("claudeVoice"))).toBe(true);
    expect(voiceTurnSelection(opus, enabled, false).instanceId).toBe("claudeVoice");
  });

  it("doesn't use it from another project or when the server doesn't list it", () => {
    expect(
      voiceInstanceEnabled(config, ProjectId.make("other"))(ProviderInstanceId.make("claudeVoice")),
    ).toBe(false);
    expect(
      voiceInstanceEnabled(config, voiceProject)(ProviderInstanceId.make("claudeVoiceThinking")),
    ).toBe(false);
  });
});

describe("isVoiceInstance", () => {
  it("names only the two voice instances", () => {
    expect(isVoiceInstance(ProviderInstanceId.make("claudeVoice"))).toBe(true);
    expect(isVoiceInstance(ProviderInstanceId.make("claudeVoiceThinking"))).toBe(true);
    expect(isVoiceInstance(ProviderInstanceId.make("claudeAgent"))).toBe(false);
  });
});
