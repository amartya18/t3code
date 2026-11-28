import type { PushLiveActivityRegistration, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as DirectApnsClient from "./DirectApnsClient.ts";
import * as DirectApnsDevices from "./DirectApnsDevices.ts";
import {
  chooseDirectPushes,
  chooseLiveActivityRefresh,
  isExpiredAgentActivityState,
  isTerminalPhase,
  LIVE_ACTIVITY_SWEEP_INTERVAL_MS,
  makeAggregateState,
  TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS,
  type DeliveredLiveActivity,
  type DirectPush,
  type DirectPushDevice,
} from "./directAgentActivityPolicy.ts";

const SEND_CONCURRENCY = 4;

type Job =
  | {
      readonly _tag: "publish";
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    }
  | { readonly _tag: "replay"; readonly deviceId: string }
  | { readonly _tag: "sweep" };

/**
 * Pushes agent activity straight to APNs with this server's own key, for forks whose bundle ID
 * the official relay's key cannot reach. It receives exactly what AgentAwarenessRelay publishes
 * and plays the relay's part: one aggregate per server, a Live Activity update when the device
 * has a card, otherwise an alert.
 */
export class DirectAgentActivity extends Context.Service<
  DirectAgentActivity,
  {
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<void>;
    /** False until an APNs key is configured. */
    readonly isEnabled: Effect.Effect<boolean>;
    readonly registerLiveActivity: (
      input: PushLiveActivityRegistration,
    ) => Effect.Effect<void, ServerSecretStore.SecretStoreError>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/relay/DirectAgentActivity") {}

const sameState = (a: RelayAgentActivityState | undefined, b: RelayAgentActivityState | null) =>
  JSON.stringify(a ?? null) === JSON.stringify(b);

const make = Effect.gen(function* () {
  const devices = yield* DirectApnsDevices.DirectApnsDevices;
  const client = yield* DirectApnsClient.DirectApnsClient;
  const startedAtMs = yield* Clock.currentTimeMillis;
  // Only the worker below reads or writes these, one job at a time.
  const rows = new Map<ThreadId, RelayAgentActivityState>();
  const delivered = new Map<string, DeliveredLiveActivity>();

  const aggregateFor = (terminalState: RelayAgentActivityState | null, nowMs: number) =>
    makeAggregateState({ activeStates: [...rows.values()], terminalState, nowMs });

  const deliver = Effect.fnUntraced(function* (
    device: DirectPushDevice,
    pushes: ReadonlyArray<DirectPush>,
    nowMs: number,
  ) {
    for (const push of pushes) {
      const result = yield* client.send({ device, request: push.request });
      const tokenGone = result.outcome === "rejected" && result.removeToken;
      if (push.kind === "alert") {
        if (tokenGone) {
          yield* devices.removeRejectedToken({
            deviceId: device.deviceId,
            apnsToken: device.apnsToken,
          });
        }
        continue;
      }
      if (push.kind === "live_activity_update" && result.outcome === "sent") {
        delivered.set(device.deviceId, {
          token: push.request.token,
          aggregate: push.aggregate,
          deliveredAtMs: nowMs,
        });
        continue;
      }
      const cardGone =
        tokenGone || (push.kind === "live_activity_end" && result.outcome === "sent");
      if (cardGone) {
        delivered.delete(device.deviceId);
        yield* devices.clearActivityToken({
          deviceId: device.deviceId,
          activityPushToken: push.request.token,
        });
      }
    }
  });

  const deliverToAll = Effect.fnUntraced(function* (
    nowMs: number,
    choose: (device: DirectPushDevice) => ReadonlyArray<DirectPush>,
  ) {
    if (!(yield* client.isConfigured)) return;
    yield* Effect.forEach(yield* devices.list, (device) => deliver(device, choose(device), nowMs), {
      concurrency: SEND_CONCURRENCY,
      discard: true,
    });
  });

  const changePushes =
    (input: {
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly state: RelayAgentActivityState | null;
      readonly nowMs: number;
      readonly replay: boolean;
    }) =>
    (device: DirectPushDevice) =>
      chooseDirectPushes({ ...input, device, delivered: delivered.get(device.deviceId) });

  const process = Effect.fnUntraced(function* (job: Job) {
    const nowMs = yield* Clock.currentTimeMillis;
    switch (job._tag) {
      case "publish": {
        const previous = rows.get(job.threadId);
        // The relay publish retries on failure, re-sending the same state.
        if (sameState(previous, job.state)) return;
        // A thread first seen with a state older than this process is a startup catch-up.
        const replay =
          previous === undefined &&
          job.state !== null &&
          Date.parse(job.state.updatedAt) < startedAtMs;
        if (job.state === null) rows.delete(job.threadId);
        else rows.set(job.threadId, job.state);
        const state = job.state;
        yield* deliverToAll(
          nowMs,
          changePushes({
            aggregate: aggregateFor(state !== null && isTerminalPhase(state) ? state : null, nowMs),
            state,
            nowMs,
            replay,
          }),
        );
        return;
      }
      case "replay": {
        delivered.delete(job.deviceId);
        const pushes = changePushes({
          aggregate: aggregateFor(null, nowMs),
          state: null,
          nowMs,
          replay: true,
        });
        yield* deliverToAll(nowMs, (device) =>
          device.deviceId === job.deviceId ? pushes(device) : [],
        );
        return;
      }
      case "sweep": {
        for (const [threadId, state] of rows) {
          const finishedLongAgo =
            isTerminalPhase(state) &&
            nowMs - Date.parse(state.updatedAt) > TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
          if (finishedLongAgo || isExpiredAgentActivityState(state, nowMs)) rows.delete(threadId);
        }
        const aggregate = aggregateFor(null, nowMs);
        if (aggregate === null) {
          const pushes = changePushes({ aggregate: null, state: null, nowMs, replay: true });
          yield* deliverToAll(nowMs, (device) => {
            const last = delivered.get(device.deviceId);
            const endDue =
              device.activityPushToken !== undefined &&
              (last === undefined ||
                nowMs - last.deliveredAtMs >= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS);
            return endDue ? pushes(device) : [];
          });
          return;
        }
        if (aggregate.activeCount === 0) return;
        yield* deliverToAll(nowMs, (device) => {
          const refresh = chooseLiveActivityRefresh({ device, aggregate, nowMs });
          return refresh ? [refresh] : [];
        });
        return;
      }
    }
  });

  // A failing push is logged by the worker and never reaches the relay publish path.
  const worker = yield* makeDrainableWorker(process);

  yield* worker
    .enqueue({ _tag: "sweep" })
    .pipe(
      Effect.schedule(Schedule.spaced(Duration.millis(LIVE_ACTIVITY_SWEEP_INTERVAL_MS))),
      Effect.forkScoped,
    );

  return DirectAgentActivity.of({
    publish: Effect.fn("DirectAgentActivity.publish")(function* ({ threadId, state }) {
      yield* worker.enqueue({ _tag: "publish", threadId, state });
    }),
    isEnabled: client.isConfigured,
    registerLiveActivity: Effect.fn("DirectAgentActivity.registerLiveActivity")(function* (input) {
      const device = yield* devices.setActivityToken({
        deviceId: input.deviceId,
        activityPushToken: input.activityPushToken,
        armedAt: DateTime.formatIso(yield* DateTime.now),
      });
      if (Option.isNone(device)) {
        yield* Effect.logWarning("live activity registered for an unknown push device");
        return;
      }
      yield* worker.enqueue({ _tag: "replay", deviceId: input.deviceId });
    }),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(DirectAgentActivity, make);
