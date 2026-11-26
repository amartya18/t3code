import { expect, it } from "vite-plus/test";

import { voiceSupport } from "./voiceSupport";

it.each([
  ["26.2.1", "available"],
  ["26.3", "available"],
  ["26.4", "needsNewerIos"],
  ["26.4.1", "needsNewerIos"],
  ["26.5.2", "needsNewerIos"],
  ["26.6", "available"],
  ["27.0", "available"],
] as const)("iOS %s is %s", (version, support) => {
  expect(voiceSupport(true, "ios", version)).toBe(support);
});

it("is unavailable without the native engine or off iOS", () => {
  expect(voiceSupport(false, "ios", "26.2")).toBe("unavailable");
  expect(voiceSupport(true, "android", 35)).toBe("unavailable");
});
