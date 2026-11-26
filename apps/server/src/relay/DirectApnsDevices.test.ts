import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, type PushDeviceRegistration } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DirectApnsDevices from "./DirectApnsDevices.ts";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const TOKEN_C = "c".repeat(64);
const SESSION = AuthSessionId.make("phone-session");

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

const phoneSession = (proofKeyThumbprint: string) =>
  ({
    subject: "managed-relay-bootstrap",
    method: "dpop-access-token",
    proofKeyThumbprint,
    ttl: Duration.hours(1),
    client: { label: "iPhone", deviceType: "mobile" },
  }) as const;

const makeSecrets = Effect.gen(function* () {
  const values = new Map<string, Uint8Array>();
  // Each write of the device file, so a test can wait for a removal the session stream triggers.
  const writes = yield* Queue.unbounded<string>();
  const layer = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.sync(() => Option.fromUndefinedOr(values.get(name))),
      set: (name, value) =>
        Effect.sync(() => void values.set(name, value)).pipe(
          Effect.andThen(Queue.offer(writes, name)),
          Effect.asVoid,
        ),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      remove: (name) => Effect.sync(() => void values.delete(name)),
      getOrCreateRandom: () => Effect.die("unused"),
    }),
  );
  return { writes, layer };
});
type Secrets = Effect.Success<typeof makeSecrets>;

const layerSessionStore = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-direct-apns-test-" })),
);

const withDevices = <A, E>(
  body: (
    devices: DirectApnsDevices.DirectApnsDevices["Service"],
    sessions: SessionStore.SessionStore["Service"],
    secrets: Secrets,
  ) => Effect.Effect<A, E>,
  existingSecrets?: Secrets,
) =>
  Effect.gen(function* () {
    const secrets = existingSecrets ?? (yield* makeSecrets);
    return yield* Effect.gen(function* () {
      const devices = yield* DirectApnsDevices.DirectApnsDevices;
      const sessions = yield* SessionStore.SessionStore;
      return yield* body(devices, sessions, secrets);
    }).pipe(
      Effect.provide(
        DirectApnsDevices.layer.pipe(
          Layer.provide(secrets.layer),
          Layer.provideMerge(layerSessionStore),
          Layer.merge(TestClock.layer()),
        ),
      ),
    );
  });

const listedIds = (devices: DirectApnsDevices.DirectApnsDevices["Service"]) =>
  devices.list.pipe(Effect.map((listed) => listed.map((device) => device.deviceId).toSorted()));

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("DirectApnsDevices", (it) => {
  it.effect("keeps a record per device so an iPhone and an iPad both get alerts", () =>
    withDevices((devices) =>
      Effect.gen(function* () {
        yield* devices.register(registration(), SESSION);
        yield* devices.register(registration({ deviceId: "ipad", apnsToken: TOKEN_B }), SESSION);
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
        yield* devices.register(registration(), SESSION);
        yield* devices.register(
          registration({
            apnsToken: TOKEN_C,
            apsEnvironment: "production",
            notifyOnCompletion: false,
          }),
          SESSION,
        );
        const listed = yield* devices.list;
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]?.apnsToken, TOKEN_C);
        assert.strictEqual(listed[0]?.apsEnvironment, "production");
        assert.strictEqual(listed[0]?.notifyOnCompletion, false);
      }),
    ),
  );

  it.effect("persists across a restart", () =>
    Effect.gen(function* () {
      const secrets = yield* makeSecrets;
      yield* withDevices((devices) => devices.register(registration(), SESSION), secrets);
      const listed = yield* withDevices((devices) => listedIds(devices), secrets);
      assert.deepStrictEqual(listed, ["iphone"]);
    }),
  );

  it.effect("keeps a card's token through re-registration and clears only that token", () =>
    withDevices((devices) =>
      Effect.gen(function* () {
        const unknown = yield* devices.setActivityToken({
          deviceId: "iphone",
          activityPushToken: TOKEN_B,
          armedAt: "2026-09-04T12:00:00.000Z",
        });
        assert.isTrue(Option.isNone(unknown));
        yield* devices.register(registration(), SESSION);
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
        yield* devices.register(registration({ notifyOnCompletion: false }), SESSION);
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
        yield* devices.register(registration(), SESSION);
        yield* devices.register(registration({ deviceId: "ipad", apnsToken: TOKEN_B }), SESSION);
        yield* devices.register(registration({ apnsToken: TOKEN_C }), SESSION);
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

  it.effect("forgets a device that unregisters, and takes it back when it registers again", () =>
    withDevices((devices) =>
      Effect.gen(function* () {
        yield* devices.register(registration(), SESSION);
        yield* devices.register(registration({ deviceId: "ipad", apnsToken: TOKEN_B }), SESSION);
        yield* devices.unregister("iphone");
        assert.deepStrictEqual(yield* listedIds(devices), ["ipad"]);
        yield* devices.register(registration(), SESSION);
        assert.deepStrictEqual(yield* listedIds(devices), ["ipad", "iphone"]);
      }),
    ),
  );

  it.effect.each([
    { name: "its session is revoked", operation: "revoke" },
    { name: "its phone's proof key is revoked", operation: "revokeByProofKey" },
    { name: "every other session is revoked", operation: "revokeAllExcept" },
  ] as const)("forgets a device when $name", ({ operation }) =>
    withDevices((devices, sessions, secrets) =>
      Effect.gen(function* () {
        const phone = yield* sessions.issue(phoneSession("phone-key"));
        const owner = yield* sessions.issue(phoneSession("owner-key"));
        yield* devices.register(registration(), phone.sessionId);
        yield* devices.register(
          registration({ deviceId: "ipad", apnsToken: TOKEN_B }),
          owner.sessionId,
        );
        yield* Queue.clear(secrets.writes);
        if (operation === "revoke") yield* sessions.revoke(phone.sessionId);
        else if (operation === "revokeByProofKey") yield* sessions.revokeByProofKey("phone-key");
        else yield* sessions.revokeAllExcept(owner.sessionId);
        yield* Queue.take(secrets.writes);
        assert.deepStrictEqual(yield* listedIds(devices), ["ipad"]);

        const repaired = yield* sessions.issue(phoneSession("phone-key-2"));
        yield* devices.register(registration(), repaired.sessionId);
        assert.deepStrictEqual(yield* listedIds(devices), ["ipad", "iphone"]);
      }),
    ),
  );

  it.effect("keeps a device whose session only expired", () =>
    withDevices((devices, sessions, secrets) =>
      Effect.gen(function* () {
        const phone = yield* sessions.issue(phoneSession("phone-key"));
        yield* devices.register(registration(), phone.sessionId);
        yield* sessions.markConnected(phone.sessionId);
        yield* TestClock.adjust(Duration.minutes(61));
        const other = yield* sessions.issue(phoneSession("other-key"));
        yield* devices.register(
          registration({ deviceId: "ipad", apnsToken: TOKEN_B }),
          other.sessionId,
        );
        yield* Queue.clear(secrets.writes);
        // The backgrounded phone's last socket closes after its session expired.
        yield* sessions.markDisconnected(phone.sessionId);
        // Session changes are handled in order, so this removal's write follows the expiry's.
        yield* sessions.revoke(other.sessionId);
        yield* Queue.take(secrets.writes);
        assert.deepStrictEqual(yield* listedIds(devices), ["iphone"]);
      }),
    ),
  );
});
