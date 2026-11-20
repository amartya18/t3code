import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type PushDeviceRegistration } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as DirectAgentActivity from "./DirectAgentActivity.ts";
import * as DirectApnsClient from "./DirectApnsClient.ts";
import * as DirectApnsDevices from "./DirectApnsDevices.ts";
import type { DirectApnsRequest } from "./directAgentActivityPolicy.ts";

const START_MS = Date.parse("2026-09-04T12:00:00.000Z");
const ALERT_TOKEN = "a".repeat(64);
const CARD_TOKEN = "c".repeat(80);
const THREAD_ID = ThreadId.make("thread-1");

const at = (msAfterStart: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(START_MS + msAfterStart));

const state = (overrides: Partial<RelayAgentActivityState> = {}): RelayAgentActivityState => ({
  environmentId: EnvironmentId.make("env-1"),
  threadId: THREAD_ID,
  projectTitle: "Project",
  threadTitle: "Fix the bug",
  phase: "running",
  headline: "Working",
  modelTitle: "Model",
  updatedAt: at(1_000),
  deepLink: "/threads/env-1/thread-1",
  ...overrides,
});

const registration: PushDeviceRegistration = {
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
};

const harness = Effect.fnUntraced(function* (
  respond: (request: DirectApnsRequest) => DirectApnsClient.DirectApnsSendResult = () => ({
    outcome: "sent",
  }),
) {
  yield* TestClock.setTime(START_MS);
  const sent: DirectApnsRequest[] = [];
  const values = new Map<string, Uint8Array>();
  const secrets = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  );
  const client = Layer.succeed(
    DirectApnsClient.DirectApnsClient,
    DirectApnsClient.DirectApnsClient.of({
      isConfigured: Effect.succeed(true),
      send: ({ request }) =>
        Effect.sync(() => {
          sent.push(request);
          return respond(request);
        }),
    }),
  );
  const context = yield* Layer.build(
    DirectAgentActivity.layer.pipe(
      Layer.provide(client),
      Layer.provideMerge(DirectApnsDevices.layer),
      Layer.provide(secrets),
    ),
  );
  const activity = Layer.succeedContext(context);
  const service = yield* DirectAgentActivity.DirectAgentActivity.pipe(Effect.provide(activity));
  const devices = yield* DirectApnsDevices.DirectApnsDevices.pipe(Effect.provide(activity));
  yield* devices.register(registration);
  const publish = (next: RelayAgentActivityState | null) =>
    service.publish({ threadId: THREAD_ID, state: next }).pipe(Effect.andThen(service.drain));
  const kinds = () => sent.splice(0).map((request) => request.pushType);
  return { service, devices, publish, sent, kinds };
});

const apsOf = (request: DirectApnsRequest | undefined) =>
  (request?.payload as { aps: Record<string, unknown> } | undefined)?.aps;

describe("DirectAgentActivity", () => {
  it.effect("alerts each new state once, and not for work already waiting at startup", () =>
    Effect.gen(function* () {
      const { publish, kinds } = yield* harness();
      // Waiting since before this process started: a catch-up, not news.
      yield* publish(state({ phase: "waiting_for_input", updatedAt: at(-60_000) }));
      assert.deepStrictEqual(kinds(), []);

      yield* publish(state({ phase: "running", updatedAt: at(1_000) }));
      yield* publish(state({ phase: "waiting_for_approval", updatedAt: at(2_000) }));
      // The relay publish failed and retried the same state.
      yield* publish(state({ phase: "waiting_for_approval", updatedAt: at(2_000) }));
      assert.deepStrictEqual(kinds(), ["alert"]);
    }),
  );

  it.effect("drives a registered card through updates and ends it once idle", () =>
    Effect.gen(function* () {
      const { service, devices, publish, sent } = yield* harness();
      yield* publish(state({ phase: "running" }));
      assert.strictEqual(sent.length, 0);

      yield* service.registerLiveActivity({ deviceId: "iphone", activityPushToken: CARD_TOKEN });
      yield* service.drain;
      const [repaint] = sent.splice(0);
      assert.strictEqual(repaint?.token, CARD_TOKEN);
      assert.strictEqual(repaint?.priority, "5");

      yield* publish(state({ phase: "waiting_for_approval", updatedAt: at(2_000) }));
      const attention = sent.splice(0);
      assert.deepStrictEqual(
        attention.map((request) => request.pushType),
        ["liveactivity"],
      );
      assert.deepInclude(apsOf(attention[0])?.alert as object, { body: "Approval: Project" });

      yield* publish(state({ phase: "completed", updatedAt: at(3_000) }));
      const done = sent.splice(0);
      assert.deepInclude(apsOf(done[0])?.alert as object, { body: "Done: Project" });

      yield* TestClock.adjust("20 minutes");
      yield* service.drain;
      const ended = sent.splice(0);
      assert.deepStrictEqual(
        ended.map((request) => [request.token, apsOf(request)?.event]),
        [[CARD_TOKEN, "end"]],
      );
      assert.strictEqual((yield* devices.list)[0]?.activityPushToken, undefined);
    }),
  );

  it.effect("falls back to alerts once APNs rejects the card's token", () =>
    Effect.gen(function* () {
      const { service, devices, publish, kinds } = yield* harness((request) =>
        request.pushType === "liveactivity"
          ? { outcome: "rejected", status: 410, reason: "Unregistered", removeToken: true }
          : { outcome: "sent" },
      );
      yield* service.registerLiveActivity({ deviceId: "iphone", activityPushToken: CARD_TOKEN });
      yield* publish(state({ phase: "running" }));
      assert.deepStrictEqual(kinds(), ["liveactivity"]);
      assert.strictEqual((yield* devices.list)[0]?.activityPushToken, undefined);

      yield* publish(state({ phase: "waiting_for_input", updatedAt: at(2_000) }));
      assert.deepStrictEqual(kinds(), ["alert"]);
    }),
  );
});
