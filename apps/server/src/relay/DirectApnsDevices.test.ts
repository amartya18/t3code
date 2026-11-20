import { assert, describe, it } from "@effect/vitest";
import type { PushDeviceRegistration } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as DirectApnsDevices from "./DirectApnsDevices.ts";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const TOKEN_C = "c".repeat(64);

const registration = (overrides: Partial<PushDeviceRegistration> = {}): PushDeviceRegistration => ({
  deviceId: "iphone",
  apnsToken: TOKEN_A,
  apsEnvironment: "sandbox",
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

const makeSecrets = () => {
  const values = new Map<string, Uint8Array>();
  const layer = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  );
  return { values, layer };
};

const withDevices = <A, E>(
  body: (devices: DirectApnsDevices.DirectApnsDevices["Service"]) => Effect.Effect<A, E>,
  secrets = makeSecrets(),
) =>
  Effect.gen(function* () {
    const devices = yield* DirectApnsDevices.DirectApnsDevices;
    return yield* body(devices);
  }).pipe(Effect.provide(DirectApnsDevices.layer.pipe(Layer.provide(secrets.layer))));

describe("DirectApnsDevices", () => {
  it.effect("keeps a record per device so an iPhone and an iPad both get alerts", () =>
    withDevices((devices) =>
      Effect.gen(function* () {
        yield* devices.register(registration());
        yield* devices.register(registration({ deviceId: "ipad", apnsToken: TOKEN_B }));
        const listed = yield* devices.list;
        assert.deepStrictEqual(listed.map((device) => device.deviceId).toSorted(), [
          "ipad",
          "iphone",
        ]);
      }),
    ),
  );

  it.effect("replaces a device's record when its token rotates or environment changes", () =>
    withDevices((devices) =>
      Effect.gen(function* () {
        yield* devices.register(registration());
        yield* devices.register(
          registration({
            apnsToken: TOKEN_C,
            apsEnvironment: "production",
            notifyOnCompletion: false,
          }),
        );
        const listed = yield* devices.list;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.apnsToken, TOKEN_C);
        assert.strictEqual(listed[0]?.apsEnvironment, "production");
        assert.strictEqual(listed[0]?.notifyOnCompletion, false);
      }),
    ),
  );

  it.effect("persists across a restart", () => {
    const secrets = makeSecrets();
    return withDevices((devices) => devices.register(registration()), secrets).pipe(
      Effect.andThen(
        withDevices(
          (devices) =>
            devices.list.pipe(
              Effect.tap((listed) =>
                Effect.sync(() =>
                  assert.deepStrictEqual(
                    listed.map((d) => d.deviceId),
                    ["iphone"],
                  ),
                ),
              ),
            ),
          secrets,
        ),
      ),
    );
  });

  it.effect("keeps a card's token through re-registration and clears only that token", () =>
    withDevices((devices) =>
      Effect.gen(function* () {
        const unknown = yield* devices.setActivityToken({
          deviceId: "iphone",
          activityPushToken: TOKEN_B,
          armedAt: "2026-09-04T12:00:00.000Z",
        });
        assert.isTrue(Option.isNone(unknown));
        yield* devices.register(registration());
        yield* devices.setActivityToken({
          deviceId: "iphone",
          activityPushToken: TOKEN_B,
          armedAt: "2026-09-04T12:00:00.000Z",
        });
        // Re-registering the same token keeps the original arming time.
        yield* devices.setActivityToken({
          deviceId: "iphone",
          activityPushToken: TOKEN_B,
          armedAt: "2026-09-04T12:05:00.000Z",
        });
        yield* devices.register(registration({ notifyOnCompletion: false }));
        const [armed] = yield* devices.list;
        assert.strictEqual(armed?.activityPushToken, TOKEN_B);
        assert.strictEqual(armed?.activityArmedAt, "2026-09-04T12:00:00.000Z");
        assert.strictEqual(armed?.notifyOnCompletion, false);

        yield* devices.clearActivityToken({ deviceId: "iphone", activityPushToken: TOKEN_C });
        assert.strictEqual((yield* devices.list)[0]?.activityPushToken, TOKEN_B);
        yield* devices.clearActivityToken({ deviceId: "iphone", activityPushToken: TOKEN_B });
        const [cleared] = yield* devices.list;
        assert.strictEqual(cleared?.activityPushToken, undefined);
        assert.strictEqual(cleared?.activityArmedAt, undefined);
      }),
    ),
  );

  it.effect("removes a rejected token but not one the device has since rotated", () =>
    withDevices((devices) =>
      Effect.gen(function* () {
        yield* devices.register(registration());
        yield* devices.register(registration({ deviceId: "ipad", apnsToken: TOKEN_B }));
        yield* devices.register(registration({ apnsToken: TOKEN_C }));
        // A BadDeviceToken for iphone's old token arrives after it rotated.
        yield* devices.removeRejectedToken({ deviceId: "iphone", apnsToken: TOKEN_A });
        assert.strictEqual((yield* devices.list).length, 2);
        yield* devices.removeRejectedToken({ deviceId: "iphone", apnsToken: TOKEN_C });
        assert.deepStrictEqual(
          (yield* devices.list).map((device) => device.deviceId),
          ["ipad"],
        );
      }),
    ),
  );
});
