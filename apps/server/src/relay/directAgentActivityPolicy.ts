// The server-side twin of the relay's delivery choice (infra/relay ApnsDeliveries.chooseDelivery
// and ApnsClient's request builders), for forks that push with their own APNs key. The pure
// aggregate, alert and payload rules live in @t3tools/shared so both stay identical.
import type { PushDeviceRegistration } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";

import { makeAggregateState, statusForPhase } from "@t3tools/shared/agentActivityAggregate";
import {
  alertForAttentionTransition,
  alertForNewlyTerminal,
  rowPhasesChanged,
  shouldAlertForActivity,
  type AgentActivityAlert,
} from "@t3tools/shared/agentActivityAlerts";
import {
  isExpiredAgentActivityState,
  isTerminalPhase,
  MAX_SUMMARY_TEXT_LENGTH,
  notificationForActivity,
  sanitizeAgentActivityAggregateState,
  truncateText,
} from "@t3tools/shared/agentActivityPayloads";

export { makeAggregateState, isExpiredAgentActivityState, isTerminalPhase };
export { TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS } from "@t3tools/shared/agentActivityAggregate";

const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const FRESHLY_ARMED_GRACE_MS = 2 * 60 * 1_000;
const LIVE_ACTIVITY_NAME = "AgentActivity";
export const LIVE_ACTIVITY_SWEEP_INTERVAL_MS = 5 * 60 * 1_000;
const MISSED_SWEEPS_BEFORE_STALE = 3;
const STALE_AFTER_SECONDS = (MISSED_SWEEPS_BEFORE_STALE * LIVE_ACTIVITY_SWEEP_INTERVAL_MS) / 1_000;
const DISMISS_AFTER_SECONDS = 5 * 60;
const CONTENTLESS_DISMISS_AFTER_SECONDS = 15;
const MAX_LIVE_ACTIVITY_PAYLOAD_BYTES = 4096;
const MIN_FITTED_TEXT_LENGTH = 8;

export interface DirectPushDevice extends PushDeviceRegistration {
  readonly activityPushToken?: string | undefined;
  /** When the current activity token was registered, so a fresh card is not ended before its first state. */
  readonly activityArmedAt?: string | undefined;
}

/** What the card for one activity token last showed; a new token starts with nothing delivered. */
export interface DeliveredLiveActivity {
  readonly token: string;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly deliveredAtMs: number;
}

export interface DirectApnsRequest {
  readonly pushType: "alert" | "liveactivity";
  readonly token: string;
  readonly priority: "5" | "10";
  readonly payload: unknown;
}

export type DirectPush =
  | { readonly kind: "alert"; readonly request: DirectApnsRequest }
  | {
      readonly kind: "live_activity_update";
      readonly request: DirectApnsRequest;
      readonly aggregate: RelayAgentActivityAggregateState;
    }
  | { readonly kind: "live_activity_end"; readonly request: DirectApnsRequest };

type ChosenLiveActivity =
  | {
      readonly kind: "live_activity_update";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert: AgentActivityAlert | null;
    }
  | { readonly kind: "live_activity_end"; readonly token: string };

function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  return aggregate.activities.some(
    (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
  );
}

function shouldUpdateLiveActivity(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly lastDeliveryAtMs: number | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previousAggregate) return true;
  if (JSON.stringify(input.previousAggregate) === JSON.stringify(input.nextAggregate)) return false;
  if (input.previousAggregate.activeCount !== input.nextAggregate.activeCount) return true;
  if (aggregateNeedsAttention(input.nextAggregate)) return true;
  if (rowPhasesChanged(input.previousAggregate, input.nextAggregate)) return true;
  return (
    input.lastDeliveryAtMs === null ||
    input.nowMs - input.lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

// A suppressed card update must not fall back to a plain alert, or a state the card already shows would ring again.
function chooseLiveActivity(input: {
  readonly device: DirectPushDevice;
  readonly delivered: DeliveredLiveActivity | undefined;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
  readonly replay: boolean;
}): ChosenLiveActivity | "suppressed" | null {
  const token = input.device.activityPushToken;
  if (!token) return null;
  if (!input.device.liveActivitiesEnabled) return { kind: "live_activity_end", token };
  if (input.aggregate === null) {
    const armedAtMs = Date.parse(input.device.activityArmedAt ?? "");
    if (Number.isFinite(armedAtMs) && input.nowMs - armedAtMs < FRESHLY_ARMED_GRACE_MS) {
      return null;
    }
    return { kind: "live_activity_end", token };
  }
  const delivered = input.delivered?.token === token ? input.delivered : undefined;
  const previousAggregate = delivered?.aggregate ?? null;
  if (
    !shouldUpdateLiveActivity({
      previousAggregate,
      nextAggregate: input.aggregate,
      lastDeliveryAtMs: delivered?.deliveredAtMs ?? null,
      nowMs: input.nowMs,
    })
  ) {
    return "suppressed";
  }
  const alert =
    input.replay || !input.device.notificationsEnabled
      ? null
      : (alertForAttentionTransition({
          previousAggregate,
          nextAggregate: input.aggregate,
          preferences: input.device,
        }) ??
        alertForNewlyTerminal({
          previousAggregate,
          nextAggregate: input.aggregate,
          preferences: input.device,
          nowMs: input.nowMs,
          includeUnobserved: true,
        }));
  return { kind: "live_activity_update", token, aggregate: input.aggregate, alert };
}

function notificationForState(input: {
  readonly device: DirectPushDevice;
  readonly state: RelayAgentActivityState | null;
  readonly nowMs: number;
}) {
  const state = input.state;
  if (!state || isExpiredAgentActivityState(state, input.nowMs)) return null;
  if (!shouldAlertForActivity({ ...state, preferences: input.device, nowMs: input.nowMs })) {
    return null;
  }
  return notificationForActivity({ ...state, status: statusForPhase(state.phase) });
}

/**
 * The pushes one device gets for a change: a Live Activity update (carrying the alert) when the
 * device has a card, otherwise a plain alert. `replay` repaints without ringing.
 */
export function chooseDirectPushes(input: {
  readonly device: DirectPushDevice;
  readonly delivered: DeliveredLiveActivity | undefined;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly state: RelayAgentActivityState | null;
  readonly nowMs: number;
  readonly replay: boolean;
}): ReadonlyArray<DirectPush> {
  const nowSeconds = Math.floor(input.nowMs / 1_000);
  const liveActivity = chooseLiveActivity(input);
  if (liveActivity === "suppressed") return [];
  const notification = input.replay ? null : notificationForState(input);
  const alertPush: ReadonlyArray<DirectPush> = notification
    ? [{ kind: "alert", request: alertRequest(input.device.apnsToken, notification) }]
    : [];
  if (liveActivity === null) return alertPush;
  if (liveActivity.kind === "live_activity_end") {
    return [
      {
        kind: "live_activity_end",
        request: liveActivityRequest({
          token: liveActivity.token,
          event: "end",
          state: null,
          alert: null,
          nowSeconds,
        }),
      },
      ...alertPush,
    ];
  }
  return [liveActivityUpdate({ ...liveActivity, nowSeconds })];
}

export function chooseLiveActivityRefresh(input: {
  readonly device: DirectPushDevice;
  readonly aggregate: RelayAgentActivityAggregateState;
  readonly nowMs: number;
}): DirectPush | null {
  const token = input.device.activityPushToken;
  if (!token || !input.device.liveActivitiesEnabled) return null;
  return liveActivityUpdate({
    token,
    aggregate: input.aggregate,
    alert: null,
    nowSeconds: Math.floor(input.nowMs / 1_000),
  });
}

function liveActivityUpdate(input: {
  readonly token: string;
  readonly aggregate: RelayAgentActivityAggregateState;
  readonly alert: AgentActivityAlert | null;
  readonly nowSeconds: number;
}): DirectPush {
  const aggregate = sanitizeAgentActivityAggregateState(input.aggregate);
  return {
    kind: "live_activity_update",
    aggregate,
    request: liveActivityRequest({
      token: input.token,
      event: "update",
      state: aggregate,
      alert: input.alert,
      nowSeconds: input.nowSeconds,
    }),
  };
}

function alertRequest(
  token: string,
  notification: ReturnType<typeof notificationForActivity>,
): DirectApnsRequest {
  return {
    pushType: "alert",
    token,
    priority: "10",
    payload: {
      aps: {
        alert: { title: notification.title, body: notification.body },
        sound: "default",
        "thread-id":
          notification.threadId.length > 0
            ? `${notification.environmentId}/${notification.threadId}`
            : "t3-agent-alerts",
      },
      // Expo iOS exposes userInfo.body as notification.content.data for remote pushes.
      body: {
        environmentId: notification.environmentId,
        threadId: notification.threadId,
        deepLink: notification.deepLink,
      },
    },
  };
}

interface LiveActivityRequestInput {
  readonly token: string;
  readonly event: "update" | "end";
  readonly state: RelayAgentActivityAggregateState | null;
  readonly alert: AgentActivityAlert | null;
  readonly nowSeconds: number;
}

// Text caps count characters, so multibyte titles can overflow APNs' 4 KB limit. Shorten text,
// then drop the lowest-priority rows, until the encoded payload fits.
function liveActivityRequest(input: LiveActivityRequestInput): DirectApnsRequest {
  let request = buildLiveActivityRequest(input);
  const state = input.state;
  if (state === null) return request;
  let rowCount = state.activities.length;
  let maxTextLength = MAX_SUMMARY_TEXT_LENGTH;
  while (
    new TextEncoder().encode(JSON.stringify(request.payload)).byteLength >
      MAX_LIVE_ACTIVITY_PAYLOAD_BYTES &&
    (rowCount > 0 || maxTextLength > MIN_FITTED_TEXT_LENGTH)
  ) {
    if (maxTextLength > MIN_FITTED_TEXT_LENGTH) {
      maxTextLength = Math.floor(maxTextLength * 0.8);
    } else {
      rowCount -= 1;
      maxTextLength = MAX_SUMMARY_TEXT_LENGTH;
    }
    const textLength = maxTextLength;
    request = buildLiveActivityRequest({
      ...input,
      state: {
        ...state,
        activities: state.activities.slice(0, rowCount).map((row) => ({
          ...row,
          projectTitle: truncateText(row.projectTitle, textLength),
          threadTitle: truncateText(row.threadTitle, textLength),
          modelTitle: truncateText(row.modelTitle, textLength),
        })),
      },
      alert: input.alert
        ? {
            title: truncateText(input.alert.title, textLength),
            body: truncateText(input.alert.body, textLength),
          }
        : null,
    });
  }
  return request;
}

function buildLiveActivityRequest(input: LiveActivityRequestInput): DirectApnsRequest {
  const timestamp = input.nowSeconds;
  // An alert dictionary wakes the screen and buzzes instead of refreshing silently.
  const alert = input.alert
    ? { alert: { title: input.alert.title, body: input.alert.body, sound: "default" } }
    : {};
  const contentState = input.state
    ? { "content-state": { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(input.state) } }
    : {};
  if (input.event === "end") {
    return {
      pushType: "liveactivity",
      token: input.token,
      priority: "10",
      payload: {
        aps: {
          timestamp,
          event: "end",
          ...contentState,
          ...alert,
          "dismissal-date":
            timestamp + (input.state ? DISMISS_AFTER_SECONDS : CONTENTLESS_DISMISS_AFTER_SECONDS),
        },
      },
    };
  }
  return {
    pushType: "liveactivity",
    token: input.token,
    priority: input.alert ? "10" : "5",
    payload: {
      aps: {
        timestamp,
        event: "update",
        ...alert,
        ...contentState,
        "stale-date": timestamp + STALE_AFTER_SECONDS,
      },
    },
  };
}
