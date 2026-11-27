import { describe, expect, it } from "vite-plus/test";

import { describeSlowCommit, screenProfileId } from "./voiceRenderLog";

describe("screenProfileId", () => {
  it("tells Home's thread apart from other threads", () => {
    expect(
      screenProfileId({ name: "Thread", params: { environmentId: "e", threadId: "home:abc" } }),
    ).toBe("Thread:home");
    expect(
      screenProfileId({ name: "Thread", params: { environmentId: "e", threadId: "thread:abc" } }),
    ).toBe("Thread");
    expect(screenProfileId({ name: "Home" })).toBe("Home");
  });
});

describe("describeSlowCommit", () => {
  it("names each profiled part of a slow commit, slowest first", () => {
    expect(
      describeSlowCommit([
        { id: "VoiceCall", phase: "update", actualMs: 4.2 },
        { id: "Thread:home", phase: "nested-update", actualMs: 51.6 },
        { id: "app", phase: "nested-update", actualMs: 70.4 },
        { id: "pill", phase: "nested-update", actualMs: 0.3 },
      ]),
    ).toBe("[voice] render nested-update 70ms: app 70, Thread:home 52, VoiceCall 4");
  });

  it("stays quiet for a commit no part of which is slow", () => {
    expect(describeSlowCommit([{ id: "app", phase: "update", actualMs: 12 }])).toBeNull();
    expect(describeSlowCommit([])).toBeNull();
  });
});
