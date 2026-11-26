import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";

import {
  chooseDirectPushes,
  makeAggregateState,
  type DirectPush,
  type DirectPushDevice,
} from "./directAgentActivityPolicy.ts";

const NOW_MS = Date.parse("2026-09-04T12:00:00.000Z");
const ALERT_TOKEN = "a".repeat(64);
const CARD_TOKEN = "c".repeat(80);

const state = (overrides: Partial<RelayAgentActivityState> = {}): RelayAgentActivityState => ({
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  projectTitle: "Project",
  threadTitle: "Fix the bug",
  phase: "running",
  headline: "Working",
  modelTitle: "Model",
  updatedAt: "2026-09-04T11:59:50.000Z",
  deepLink: "/threads/env-1/thread-1",
  ...overrides,
});

const device = (overrides: Partial<DirectPushDevice> = {}): DirectPushDevice => ({
  deviceId: "iphone",
  apnsToken: ALERT_TOKEN,
  apsEnvironment: "production",
  bundleId: "com.example.t3code",
  platform: "ios",
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
  ...overrides,
});

const apsOf = (push: DirectPush | undefined) =>
  (push?.request.payload as { readonly aps: Record<string, unknown> } | undefined)?.aps;

const aggregateOf = (...states: ReadonlyArray<RelayAgentActivityState>) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: NOW_MS });

const choose = (input: Partial<Parameters<typeof chooseDirectPushes>[0]> = {}) => {
  const published = input.state ?? null;
  return chooseDirectPushes({
    device: device(),
    delivered: undefined,
    aggregate: published ? aggregateOf(published) : null,
    state: published,
    nowMs: NOW_MS,
    replay: false,
    ...input,
  });
};

describe("chooseDirectPushes", () => {
  it("alerts a device without a card, and stays quiet on replay or when the user opted out", () => {
    const waiting = state({ phase: "waiting_for_approval" });
    const [push] = choose({ state: waiting });
    expect(push?.kind).toBe("alert");
    expect(push?.request).toMatchObject({ pushType: "alert", token: ALERT_TOKEN, priority: "10" });
    expect(push?.request.payload).toMatchObject({
      aps: { alert: { title: "Fix the bug", body: "Approval: Project" } },
      body: { threadId: "thread-1", deepLink: "/threads/env-1/thread-1" },
    });
    expect(choose({ state: waiting, replay: true })).toEqual([]);
    expect(choose({ state: waiting, device: device({ notifyOnApproval: false }) })).toEqual([]);
    expect(choose({ state: state({ phase: "running" }) })).toEqual([]);
  });

  it("puts the alert on the card's update instead of a separate push", () => {
    const running = state();
    const waiting = state({ phase: "waiting_for_approval", updatedAt: "2026-09-04T11:59:59.000Z" });
    const armed = device({ activityPushToken: CARD_TOKEN });
    const pushes = choose({
      device: armed,
      delivered: { token: CARD_TOKEN, aggregate: aggregateOf(running), deliveredAtMs: NOW_MS },
      state: waiting,
    });
    expect(pushes.map((push) => push.kind)).toEqual(["live_activity_update"]);
    expect(pushes[0]?.request).toMatchObject({
      pushType: "liveactivity",
      token: CARD_TOKEN,
      priority: "10",
    });
    const aps = apsOf(pushes[0]);
    expect(aps?.alert).toMatchObject({ title: "Fix the bug", body: "Approval: Project" });
    const contentState = aps?.["content-state"] as { name: string; props: string } | undefined;
    expect(contentState?.name).toBe("AgentActivity");
    expect(JSON.parse(contentState?.props ?? "{}").activities[0].phase).toBe(
      "waiting_for_approval",
    );

    // The same aggregate again is suppressed, never downgraded to a plain alert.
    expect(
      choose({
        device: armed,
        delivered: { token: CARD_TOKEN, aggregate: aggregateOf(waiting), deliveredAtMs: NOW_MS },
        state: waiting,
      }),
    ).toEqual([]);
  });

  it("repaints a fresh card silently on replay", () => {
    const [push] = choose({
      device: device({ activityPushToken: CARD_TOKEN }),
      state: state({ phase: "waiting_for_input" }),
      replay: true,
    });
    expect(push?.kind).toBe("live_activity_update");
    expect(push?.request.priority).toBe("5");
    expect(apsOf(push)).not.toHaveProperty("alert");
  });

  it("ends a card with nothing to show, but not one armed moments ago", () => {
    const armedAt = (msAgo: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW_MS - msAgo));
    const freshlyArmed = device({ activityPushToken: CARD_TOKEN, activityArmedAt: armedAt(1_000) });
    expect(choose({ device: freshlyArmed })).toEqual([]);
    const idle = device({ activityPushToken: CARD_TOKEN, activityArmedAt: armedAt(5 * 60_000) });
    const [end] = choose({ device: idle });
    expect(end?.kind).toBe("live_activity_end");
    expect(apsOf(end)).toMatchObject({ event: "end" });
  });

  it("ends the card when the user turns Live Activities off", () => {
    const pushes = choose({
      device: device({ activityPushToken: CARD_TOKEN, liveActivitiesEnabled: false }),
      state: state(),
    });
    expect(pushes.map((push) => push.kind)).toEqual(["live_activity_end"]);
  });
});
