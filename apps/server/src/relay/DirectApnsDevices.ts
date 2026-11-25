import { type AuthSessionId, PushDeviceRegistration } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { DirectPushDevice } from "./directAgentActivityPolicy.ts";

// APNs tokens are bearer-like identifiers for pushing to a phone, so they live in the secret
// store rather than in settings.json or the database.
const DEVICES_SECRET = "direct-apns-devices";

const StoredPushDevice = Schema.Struct({
  ...PushDeviceRegistration.fields,
  activityPushToken: Schema.optional(Schema.String),
  activityArmedAt: Schema.optional(Schema.String),
});
const DevicesJson = Schema.fromJsonString(Schema.Array(StoredPushDevice));
const decodeDevices = Schema.decodeUnknownEffect(DevicesJson);
const encodeDevices = Schema.encodeEffect(DevicesJson);

export class DirectApnsDevices extends Context.Service<
  DirectApnsDevices,
  {
    /** Keeps the device's Live Activity token: a preference refresh does not end its card. */
    readonly register: (
      device: PushDeviceRegistration,
      sessionId: AuthSessionId,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly unregister: (
      deviceId: string,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly list: Effect.Effect<
      ReadonlyArray<DirectPushDevice>,
      ServerSecretStore.SecretStoreError
    >;
    /** Returns the updated device, or none when the device never registered. */
    readonly setActivityToken: (input: {
      readonly deviceId: string;
      readonly activityPushToken: string;
      readonly armedAt: string;
    }) => Effect.Effect<Option.Option<DirectPushDevice>, ServerSecretStore.SecretStoreError>;
    /** Drops an ended or rejected card's token, unless the device has since registered a new one. */
    readonly clearActivityToken: (input: {
      readonly deviceId: string;
      readonly activityPushToken: string;
    }) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    /** Forgets a device whose alert token APNs rejected, unless it has since registered a new token. */
    readonly removeRejectedToken: (input: {
      readonly deviceId: string;
      readonly apnsToken: string;
    }) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
  }
>()("t3/relay/DirectApnsDevices") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  // Registrations, Live Activity token changes and APNs rejections all rewrite one file.
  const lock = yield* Semaphore.make(1);

  const read = secrets.get(DEVICES_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<ReadonlyArray<DirectPushDevice>>([]),
        onSome: (bytes) =>
          decodeDevices(new TextDecoder().decode(bytes)).pipe(
            // A corrupt file must not block registering a fresh token.
            Effect.orElseSucceed((): ReadonlyArray<DirectPushDevice> => []),
          ),
      }),
    ),
  );

  const modify = (
    change: (devices: ReadonlyArray<DirectPushDevice>) => ReadonlyArray<DirectPushDevice>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* read;
        const next = change(current);
        if (next.length === current.length && next.every((device, i) => device === current[i])) {
          return next;
        }
        const encoded = yield* encodeDevices(next).pipe(Effect.orDie);
        yield* secrets.set(DEVICES_SECRET, new TextEncoder().encode(encoded));
        return next;
      }),
    );

  const updateDevice = (deviceId: string, change: (device: DirectPushDevice) => DirectPushDevice) =>
    modify((devices) =>
      devices.map((device) => (device.deviceId === deviceId ? change(device) : device)),
    );

  return DirectApnsDevices.of({
    register: Effect.fn("DirectApnsDevices.register")(function* (registration) {
      yield* modify((devices) => {
        const existing = devices.find((device) => device.deviceId === registration.deviceId);
        const device: DirectPushDevice = {
          ...registration,
          ...(existing?.activityPushToken === undefined
            ? {}
            : {
                activityPushToken: existing.activityPushToken,
                activityArmedAt: existing.activityArmedAt,
              }),
        };
        return [...devices.filter((other) => other.deviceId !== device.deviceId), device];
      });
    }),
    unregister: () => Effect.void,
    list: lock.withPermits(1)(read),
    setActivityToken: Effect.fn("DirectApnsDevices.setActivityToken")(function* (input) {
      const devices = yield* updateDevice(input.deviceId, (device) =>
        device.activityPushToken === input.activityPushToken
          ? device
          : {
              ...device,
              activityPushToken: input.activityPushToken,
              activityArmedAt: input.armedAt,
            },
      );
      return Option.fromUndefinedOr(devices.find((device) => device.deviceId === input.deviceId));
    }),
    clearActivityToken: Effect.fn("DirectApnsDevices.clearActivityToken")(function* (input) {
      yield* updateDevice(input.deviceId, (device) => {
        if (device.activityPushToken !== input.activityPushToken) return device;
        const { activityPushToken: _token, activityArmedAt: _armedAt, ...rest } = device;
        return rest;
      });
    }),
    removeRejectedToken: Effect.fn("DirectApnsDevices.removeRejectedToken")(function* (input) {
      yield* modify((devices) =>
        devices.filter(
          (device) => !(device.deviceId === input.deviceId && device.apnsToken === input.apnsToken),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(DirectApnsDevices, make);
