import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import { splitOlderModels, voiceReasoning, withLowEffort } from "./voiceModels";

vi.mock("../../state/entities", () => ({ useEnvironmentServerConfig: () => null }));

const EFFORT: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      promptInjectedValues: ["ultrathink"],
    },
  ],
};

function model(slug: string, input: Partial<ModelOption> = {}): ModelOption {
  return {
    key: `claudeAgent:${slug}`,
    label: slug,
    subtitle: "",
    providerKey: "claudeAgent",
    providerLabel: "Claude",
    providerDriver: "claudeAgent",
    isDefault: false,
    isLegacy: false,
    capabilities: EFFORT,
    selection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: slug },
    ...input,
  };
}

const opus = model("claude-opus-5-5");
const sonnet = model("claude-sonnet-5-5");
const oldOpus = model("claude-opus-4-8", { isLegacy: true });

describe("splitOlderModels", () => {
  it("keeps older models out of the list", () => {
    expect(splitOlderModels([opus, oldOpus, sonnet], opus.key)).toEqual({
      current: [opus, sonnet],
      older: [oldOpus],
    });
  });

  it("keeps an older model in the list while it is the pick", () => {
    expect(splitOlderModels([opus, oldOpus], oldOpus.key)).toEqual({
      current: [opus, oldOpus],
      older: [],
    });
  });
});

describe("voiceReasoning", () => {
  it("offers the model's levels without prompt-only ones", () => {
    const reasoning = voiceReasoning(opus, withLowEffort(opus));
    expect(reasoning?.label).toBe("Reasoning");
    expect(reasoning?.current).toBe("low");
    expect(reasoning?.choices.map((choice) => choice.id)).toEqual(["low", "medium", "high"]);
  });

  it("changes only the reasoning level of the pick", () => {
    const next = voiceReasoning(opus, withLowEffort(opus))?.select("high");
    expect(next).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(voiceReasoning(opus, next!)?.current).toBe("high");
  });

  it("has no control for a model without reasoning levels", () => {
    const plain = model("custom", { capabilities: null });
    expect(voiceReasoning(plain, plain.selection)).toBeNull();
    expect(withLowEffort(plain)).toEqual(plain.selection);
  });
});
