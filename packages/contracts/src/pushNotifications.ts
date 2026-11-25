import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PushApsEnvironment = Schema.Literals(["sandbox", "production"]);
export type PushApsEnvironment = typeof PushApsEnvironment.Type;

// Tokens are interpolated into the APNs request path, so only hex is accepted.
const ApnsToken = Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{32,400}$/));
export const PushDeviceId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const PushDeviceRegistration = Schema.Struct({
  deviceId: PushDeviceId,
  apnsToken: ApnsToken,
  apsEnvironment: PushApsEnvironment,
  bundleId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  platform: Schema.Literal("ios"),
  liveActivitiesEnabled: Schema.Boolean,
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
});
export type PushDeviceRegistration = typeof PushDeviceRegistration.Type;

export const PushLiveActivityRegistration = Schema.Struct({
  deviceId: PushDeviceId,
  activityPushToken: ApnsToken,
});
export type PushLiveActivityRegistration = typeof PushLiveActivityRegistration.Type;
